// Shared send pipeline for CLI and MCP: validate -> policy -> preview -> (confirm outside) -> ledger pending -> broadcast -> ledger result.
import { randomBytes } from 'node:crypto';
import { readSecret, signPolicy, verifyPolicy, saveVaultFile, openVault, DEFAULT_VAULT_PATH } from './vault.mjs';
import { evmFromPrivateKey, solFromSecretKey } from './wallets.mjs';
import { evmFromMnemonic, solFromMnemonic } from './wallets.mjs';
import { previewSend, validateRecipient, isSol } from './chains.mjs';
import { evaluate } from './policy.mjs';
import { appendLedger, withLedgerLock, verifyLedger, initLedger } from './ledger.mjs';

/** Open the vault and, if it was just created, lay down its ledger files in the same step. */
export async function openVaultFull(passphrase, path = DEFAULT_VAULT_PATH, opts = {}) {
  const r = openVault(passphrase, path, opts);
  if (r.created) await withLedgerLock(() => initLedger(r.key, r.vault));
  return r;
}

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
export async function prepareSend({ entry, key, vault, chain, to: rawTo, amount, index = 0, via = 'cli' }) {
  if (!vault) throw new Error('prepareSend needs the vault');
  const log = (rec) => appendLedger(rec, key, vault);
  const to = validateRecipient(chain, rawTo);
  if (!entry.chains.includes(isSol(chain) ? 'sol' : 'evm')) throw new Error(`wallet has no ${isSol(chain) ? 'solana' : 'evm'} key`);
  const policy = evaluate(entry, { chain, to, amount, via, key, vault });
  if (!policy.ok && via !== 'cli') {
    await withLedgerLock(() => { try { log({ attempt: randomBytes(6).toString('hex'), wallet: entry.id, label: entry.label, chain, to, amount: Number(amount), via, status: 'denied', reasons: policy.reasons }); } catch {} });
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
export async function executeSend({ entry, key, vault, chain, via, preview, overridden = false }) {
  if (!key || !vault) throw new Error('executeSend needs the vault key and vault');
  const log = (rec) => appendLedger(rec, key, vault);
  const attempt = randomBytes(6).toString('hex');
  const base = { attempt, wallet: entry.id, label: entry.label, chain, to: preview.to, amount: Number(preview.amount), via, overridden };
  const { hash, send } = await preview._prepare();
  await withLedgerLock(() => {
    if (!overridden) {
      const check = evaluate(entry, { chain, to: preview.to, amount: preview.amount, via, key, vault });
      if (!check.ok) {
        log({ ...base, status: 'denied', reasons: check.reasons });
        const err = new Error(`policy denied at broadcast time: ${check.reasons.join('; ')}`);
        err.denied = true; err.reasons = check.reasons;
        throw err;
      }
    }
    log({ ...base, hash, status: 'pending' });
  });
  try {
    const result = await send();
    await withLedgerLock(() => log({ ...base, hash, status: 'sent', result: String(result) }));
    return result;
  } catch (e) {
    // We cannot know whether the RPC accepted it before failing. Keep it on the budget.
    await withLedgerLock(() => log({ ...base, hash, status: 'unknown', error: (e.shortMessage || e.message || String(e)).slice(0, 200) }));
    e.message = `${e.shortMessage || e.message} [recorded as unknown, hash ${hash}; run: wv reconcile ${entry.label}]`;
    throw e;
  }
}

/** Settle pending/unknown ledger records from chain state. Returns [{attempt, hash, chain, before, after}]. */
export async function reconcile(records, { txStatus, key, vault }) {
  const out = [];
  for (const r of records.filter(r => (r.status === 'pending' || r.status === 'unknown') && r.hash)) {
    let st; try { st = await txStatus(r.chain, r.hash); } catch (e) { st = `error: ${e.message.slice(0, 60)}`; }
    let after = r.status;
    if (st === 'confirmed') after = 'sent';
    else if (st === 'reverted') after = 'failed';
    else if (st === 'notfound' && Date.now() - Date.parse(r.ts) > 48 * 3_600_000) after = 'failed'; // past any nonce/blockhash validity
    if (after !== r.status) await withLedgerLock(() => appendLedger({ attempt: r.attempt, wallet: r.wallet, label: r.label, chain: r.chain, to: r.to, amount: r.amount, via: r.via, hash: r.hash, status: after, reconciled: st }, key, vault));
    out.push({ attempt: r.attempt, hash: r.hash, chain: r.chain, before: r.status, chainStatus: st, after });
  }
  return out;
}

/** Mutate entry.policy from CLI flags. */
export function applyPolicyFlags(entry, key, vault, { chains, perTx, perDay, agent, note, allowAdd, allowRemove, clear }) {
  if (clear) { delete entry.policy; signPolicy(key, entry); return; }
  // Never build on top of an unverified policy (it may have been edited on disk): clear first, then set fresh.
  if (entry.policy && !verifyPolicy(key, entry)) throw new Error('existing policy fails its signature; run "wv policy clear" first, then set it again');
  const lv = verifyLedger(key, vault);
  if (!lv.ok) throw new Error(`refusing to sign a policy while the ledger fails verification: ${lv.reason} ("wv ledger verify", or "wv ledger reset" to start a new epoch)`);
  // Refuse to sign a policy onto an entry whose secret does not derive to its stated addresses.
  const sec = readSecret(entry, key);
  if (entry.addresses.evm && evmFromPrivateKey(sec.evmPrivateKey).address.toLowerCase() !== entry.addresses.evm.toLowerCase()) throw new Error('entry EVM address does not match its key; refusing to sign policy');
  if (entry.addresses.sol && solFromSecretKey(sec.solSecretKey).address !== entry.addresses.sol) throw new Error('entry Solana address does not match its key; refusing to sign policy');
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
  signPolicy(key, entry);
}
