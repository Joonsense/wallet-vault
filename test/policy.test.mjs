import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WV_LEDGER = join(mkdtempSync(join(tmpdir(), 'wvl-')), 'ledger.jsonl');
const { deriveKey, emptyVault, signPolicy } = await import('../src/vault.mjs');
const key = deriveKey('unit test passphrase', emptyVault().kdf.salt);
const signed = (e) => { signPolicy(key, e); return e; };
const { evaluate } = await import('../src/policy.mjs');
const { appendLedger, spentInWindow, verifyLedger, withLedgerLock } = await import('../src/ledger.mjs');

const base = { id: 7, label: 'bot', chains: ['evm', 'sol'], addresses: { evm: '0xA', sol: 'S' } };
const pol = { chains: ['base', 'sol-devnet'], allow: ['0x000000000000000000000000000000000000dEaD'], limits: { base: { perTx: 0.01, perDay: 0.03 }, '*': { perTx: 0.5, perDay: 1 } }, agent: true };

test('no policy: cli ok, mcp denied', () => {
  assert.equal(evaluate(base, { chain: 'base', to: '0x1', amount: 1, via: 'cli', key }).ok, true);
  assert.equal(evaluate(base, { chain: 'base', to: '0x1', amount: 1, via: 'mcp', key }).ok, false);
});

test('chain, allowlist, per-tx', () => {
  const e = signed({ ...base, policy: structuredClone(pol) });
  assert.equal(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.005, via: 'mcp', key }).ok, true);
  assert.match(evaluate(e, { chain: 'arb', to: '0x000000000000000000000000000000000000dead', amount: 0.005, via: 'mcp', key }).reasons[0], /chain arb not in policy/);
  assert.match(evaluate(e, { chain: 'base', to: '0x1111111111111111111111111111111111111111', amount: 0.005, via: 'mcp', key }).reasons[0], /not in allowlist/);
  assert.match(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.02, via: 'mcp', key }).reasons[0], /per-tx/);
  // wildcard limit applies to sol-devnet; allowlist is address based, Solana addr not listed -> denied
  assert.match(evaluate(e, { chain: 'sol-devnet', to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: 0.1, via: 'mcp', key }).reasons[0], /allowlist/);
});

test('daily window counts sent + pending, not failed/denied', () => {
  const e = signed({ ...base, policy: structuredClone(pol) });
  for (const r of [
    { attempt: 'a1', wallet: 7, chain: 'base', amount: 0.01, status: 'pending' },
    { attempt: 'a1', wallet: 7, chain: 'base', amount: 0.01, status: 'sent' },
    { attempt: 'a2', wallet: 7, chain: 'base', amount: 0.01, status: 'pending' },
    { attempt: 'a3', wallet: 7, chain: 'base', amount: 0.01, status: 'failed' },
    { attempt: 'a4', wallet: 7, chain: 'base', amount: 0.01, status: 'denied' },
    { attempt: 'a5', wallet: 8, chain: 'base', amount: 0.01, status: 'sent' },
  ]) appendLedger(r, key);
  assert.equal(verifyLedger(key).ok, true);
  assert.equal(spentInWindow(7, 'base'), 0.02);
  const r = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.01, via: 'mcp', key });
  assert.equal(r.ok, true);
  const r2 = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.0101, via: 'mcp', key });
  assert.match(r2.reasons.join(), /daily limit/);
});

test('tampering is detected: edited policy, truncated ledger, edited record', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const e = signed({ ...base, id: 9, policy: structuredClone(pol) });
  e.policy.limits.base.perTx = 100;   // agent edits vault.json to loosen its limit
  const r = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 50, via: 'mcp', key });
  assert.match(r.reasons.join(), /policy signature invalid/);
  const path = process.env.WV_LEDGER;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  writeFileSync(path, lines.slice(0, -1).join('\n') + '\n');           // truncate
  assert.match(verifyLedger(key).reason, /truncated/);
  assert.throws(() => appendLedger({ attempt: 'x', wallet: 7, chain: 'base', amount: 0.01, status: 'sent' }, key), /integrity/);
  const last = JSON.parse(lines[lines.length - 1]); last.amount = 0; lines[lines.length - 1] = JSON.stringify(last);
  writeFileSync(path, lines.join('\n') + '\n');                        // edit a record
  assert.match(verifyLedger(key).reason, /fails its MAC/);
  const e2 = signed({ ...base, policy: structuredClone(pol) });
  const r2 = evaluate(e2, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.001, via: 'mcp', key });
  assert.match(r2.reasons.join(), /ledger integrity/);
});
