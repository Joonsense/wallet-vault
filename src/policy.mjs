// Spend policy per wallet. Stored on the vault entry as plain metadata (it is not a secret, but it is tamper-evident
// only as far as the vault file is: keep the vault file 600 and back it up).
//
// entry.policy = {
//   chains: ['base', 'sol-devnet'],            // chains this wallet may send on (empty = none)
//   allow:  ['0xabc...', 'Sol...'],            // recipient allowlist (empty = any recipient)
//   limits: { 'base': { perTx: 0.01, perDay: 0.05 }, '*': { perTx: 0.001, perDay: 0.003 } },  // native units per chain
//   agent:  true,                              // exposed to the MCP server
//   note:   'swan hot wallet'
// }
import { spentInWindow, verifyLedger } from './ledger.mjs';
import { verifyPolicy } from './vault.mjs';
import { isSol } from './chains.mjs';

export function emptyPolicy() {
  return { chains: [], allow: [], limits: {}, agent: false, note: '' };
}

export function limitFor(policy, chain) {
  return policy.limits?.[chain] || policy.limits?.['*'] || null;
}

function sameAddr(a, b, chain) {
  return isSol(chain) ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Evaluate a proposed native send. Returns { ok, reasons: [], limit, spentToday }.
 * `via` is 'cli' or 'mcp'. Without a policy a human on the CLI may proceed (they confirm interactively),
 * an agent may not.
 */
export function evaluate(entry, { chain, to, amount, via = 'cli', now = Date.now(), key }) {
  const reasons = [];
  const p = entry.policy;
  const amt = Number(amount);
  if (!key) throw new Error('evaluate needs the vault key');
  if (!verifyPolicy(key, entry)) reasons.push('policy signature invalid: vault.json was edited outside wv (re-save with wv policy set, or wv policy clear)');
  const ledger = verifyLedger(key);
  if (!ledger.ok) reasons.push(`ledger integrity failure: ${ledger.reason}`);
  if (!p) {
    if (via !== 'cli') reasons.push('wallet has no spend policy; agent access requires one (wv policy set ...)');
    return { ok: reasons.length === 0, reasons, limit: null, spentToday: 0, policy: null };
  }
  if (via !== 'cli' && !p.agent) reasons.push('wallet is not agent-enabled (wv policy set <wallet> --agent on)');
  if (!p.chains?.length) reasons.push('policy allows no chains');
  else if (!p.chains.includes(chain)) reasons.push(`chain ${chain} not in policy chains [${p.chains.join(', ')}]`);
  if (p.allow?.length && !p.allow.some(a => sameAddr(a, to, chain))) reasons.push(`recipient ${to} not in allowlist`);
  const limit = limitFor(p, chain);
  if (!limit) reasons.push(`no limit set for ${chain} (set --per-tx/--per-day for it or for '*')`);
  let spentToday = 0;
  if (limit) {
    if (!(amt > 0)) reasons.push('amount must be > 0');
    if (limit.perTx != null && amt > limit.perTx) reasons.push(`amount ${amt} exceeds per-tx limit ${limit.perTx}`);
    if (limit.perDay != null) {
      spentToday = spentInWindow(entry.id, chain, 86_400_000, now, ledger.records.filter(r => !r._corrupt));
      if (spentToday + amt > limit.perDay) reasons.push(`daily limit ${limit.perDay}: already ${spentToday} in the last 24h, +${amt} exceeds it`);
    }
  }
  return { ok: reasons.length === 0, reasons, limit, spentToday, policy: p };
}

export function describePolicy(p) {
  if (!p) return '(no policy: CLI sends allowed with confirmation, agent sends denied)';
  const lim = Object.entries(p.limits || {}).map(([k, v]) => `${k}: per-tx ${v.perTx ?? '-'} / per-day ${v.perDay ?? '-'}`);
  return [
    `agent    ${p.agent ? 'ENABLED (exposed via MCP)' : 'off'}`,
    `chains   ${p.chains?.length ? p.chains.join(', ') : '(none)'}`,
    `allow    ${p.allow?.length ? p.allow.join(', ') : '(any recipient)'}`,
    `limits   ${lim.length ? lim.join(' | ') : '(none)'}`,
    p.note ? `note     ${p.note}` : null,
  ].filter(Boolean).join('\n');
}
