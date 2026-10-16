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
 * The policy is re-evaluated and the pending reservation written inside one ledger lock, so two concurrent sends
 * (two MCP calls, or CLI + MCP) cannot both pass the daily limit. The earlier evaluate() in prepareSend is advisory.
 */
export async function executeSend({ entry, chain, via, preview, overridden = false }) {
  const attempt = randomBytes(6).toString('hex');
  const base = { attempt, wallet: entry.id, label: entry.label, chain, to: preview.to, amount: Number(preview.amount), via, overridden };
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
    appendLedger({ ...base, status: 'pending' });
  });
  try {
    const result = await preview._exec();
    appendLedger({ ...base, status: 'sent', hash: String(result).split(' ')[0], result: String(result) });
    return result;
  } catch (e) {
    appendLedger({ ...base, status: 'failed', error: (e.shortMessage || e.message || String(e)).slice(0, 200) });
    throw e;
  }
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
