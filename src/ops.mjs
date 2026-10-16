// Shared send pipeline for CLI and MCP: validate -> policy -> preview -> (confirm outside) -> ledger pending -> broadcast -> ledger result.
import { randomBytes } from 'node:crypto';
import { readSecret, saveVaultFile } from './vault.mjs';
import { evmFromMnemonic, solFromMnemonic } from './wallets.mjs';
import { previewSend, validateRecipient, isSol } from './chains.mjs';
import { evaluate } from './policy.mjs';
import { appendLedger, withLedgerLock } from './ledger.mjs';

/** Addresses + secrets of an entry at a derivation index (0 = stored values). */
export function materialize(e, s, idx = 0) {
  const out = { evm: null, sol: null };
  if (e.chains.includes('evm')) {
    out.evm = idx === 0 || s.kind !== 'mnemonic' ? { address: e.addresses.evm, privateKey: s.evmPrivateKey } : evmFromMnemonic(s.mnemonic, idx);
  }
  if (e.chains.includes('sol')) {
    out.sol = idx === 0 || s.kind !== 'mnemonic' ? { address: e.addresses.sol, secretKey: s.solSecretKey } : solFromMnemonic(s.mnemonic, idx);
  }
  return out;
}

/**
 * Prepare a native send. Throws on validation errors. Returns { to, policy, preview } where policy.ok may be false
 * (caller decides: CLI may override with explicit consent, MCP never).
 */
export async function prepareSend({ entry, key, chain, to: rawTo, amount, index = 0, via = 'cli' }) {
  const to = validateRecipient(chain, rawTo);
  if (!entry.chains.includes(isSol(chain) ? 'sol' : 'evm')) throw new Error(`wallet has no ${isSol(chain) ? 'solana' : 'evm'} key`);
  const policy = evaluate(entry, { chain, to, amount, via });
  if (!policy.ok && via !== 'cli') {
    appendLedger({ attempt: randomBytes(6).toString('hex'), wallet: entry.id, label: entry.label, chain, to, amount: Number(amount), via, status: 'denied', reasons: policy.reasons });
    return { to, policy, preview: null };
  }
  const w = materialize(entry, readSecret(entry, key), index);
  const preview = await previewSend(chain, {
    from: isSol(chain) ? w.sol.address : w.evm.address, to, amount,
    privateKey: w.evm?.privateKey, secretKey: w.sol?.secretKey,
  });
  return { to, policy, preview };
}

/**
 * Broadcast a prepared send with ledger bookkeeping. Returns the chain result string (hash ...).
 * 1. sign locally (hash known, nothing broadcast yet; an error here reserves nothing)
 * 2. under the ledger lock: re-evaluate policy, write 'pending' with the hash  (atomic check-and-reserve)
 * 3. broadcast + confirm. Success -> 'sent'. Any error after this point -> 'unknown' (still counted against the
 *    budget, because the tx may be on chain); `wv reconcile` later settles it from chain state.
 */
export async function executeSend({ entry, chain, via, preview, overridden = false }) {
  const attempt = randomBytes(6).toString('hex');
  const base = { attempt, wallet: entry.id, label: entry.label, chain, to: preview.to, amount: Number(preview.amount), via, overridden };
  const { hash, send } = await preview._prepare();
  await withLedgerLock(() => {
    if (!overridden) {
      const check = evaluate(entry, { chain, to: preview.to, amount: preview.amount, via });
      if (!check.ok) {
        appendLedger({ ...base, status: 'denied', reasons: check.reasons });
        const err = new Error(`policy denied at broadcast time: ${check.reasons.join('; ')}`);
        err.denied = true; err.reasons = check.reasons;
        throw err;
      }
    }
    appendLedger({ ...base, hash, status: 'pending' });
  });
  try {
    const result = await send();
    appendLedger({ ...base, hash, status: 'sent', result: String(result) });
    return result;
  } catch (e) {
    // We cannot know whether the RPC accepted it before failing. Keep it on the budget.
    appendLedger({ ...base, hash, status: 'unknown', error: (e.shortMessage || e.message || String(e)).slice(0, 200) });
    e.message = `${e.shortMessage || e.message} [recorded as unknown, hash ${hash}; run: wv reconcile ${entry.label}]`;
    throw e;
  }
}

/** Settle pending/unknown ledger records from chain state. Returns [{attempt, hash, chain, before, after}]. */
export async function reconcile(records, { txStatus }) {
  const out = [];
  for (const r of records.filter(r => (r.status === 'pending' || r.status === 'unknown') && r.hash)) {
    let st; try { st = await txStatus(r.chain, r.hash); } catch (e) { st = `error: ${e.message.slice(0, 60)}`; }
    let after = r.status;
    if (st === 'confirmed') after = 'sent';
    else if (st === 'reverted') after = 'failed';
    else if (st === 'notfound' && Date.now() - Date.parse(r.ts) > 48 * 3_600_000) after = 'failed'; // past any nonce/blockhash validity
    if (after !== r.status) appendLedger({ attempt: r.attempt, wallet: r.wallet, label: r.label, chain: r.chain, to: r.to, amount: r.amount, via: r.via, hash: r.hash, status: after, reconciled: st });
    out.push({ attempt: r.attempt, hash: r.hash, chain: r.chain, before: r.status, chainStatus: st, after });
  }
  return out;
}

/** Mutate entry.policy from CLI flags. */
export function applyPolicyFlags(entry, { chains, perTx, perDay, agent, note, allowAdd, allowRemove, clear }) {
  if (clear) { delete entry.policy; return; }
  const p = entry.policy || { chains: [], allow: [], limits: {}, agent: false, note: '' };
  if (chains?.length) {
    for (const c of chains) {
      if (c !== '*' && !p.chains.includes(c)) p.chains.push(c);
      if (perTx != null || perDay != null) {
        p.limits[c] = { ...(p.limits[c] || {}) };
        if (perTx != null) p.limits[c].perTx = perTx;
        if (perDay != null) p.limits[c].perDay = perDay;
      }
    }
  } else if (perTx != null || perDay != null) {
    throw new Error('--per-tx/--per-day need --chain <keys> or --chain "*"');
  }
  if (agent != null) p.agent = agent;
  if (note != null) p.note = note;
  for (const a of allowAdd || []) if (!p.allow.includes(a)) p.allow.push(a);
  if (allowRemove?.length) p.allow = p.allow.filter(a => !allowRemove.some(r => r.toLowerCase() === a.toLowerCase()));
  entry.policy = p;
}
