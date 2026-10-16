import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WV_LEDGER = join(mkdtempSync(join(tmpdir(), 'wvl-')), 'ledger.jsonl');
const { evaluate } = await import('../src/policy.mjs');
const { appendLedger, spentInWindow } = await import('../src/ledger.mjs');

const base = { id: 7, label: 'bot', chains: ['evm', 'sol'], addresses: { evm: '0xA', sol: 'S' } };
const pol = { chains: ['base', 'sol-devnet'], allow: ['0x000000000000000000000000000000000000dEaD'], limits: { base: { perTx: 0.01, perDay: 0.03 }, '*': { perTx: 0.5, perDay: 1 } }, agent: true };

test('no policy: cli ok, mcp denied', () => {
  assert.equal(evaluate(base, { chain: 'base', to: '0x1', amount: 1, via: 'cli' }).ok, true);
  assert.equal(evaluate(base, { chain: 'base', to: '0x1', amount: 1, via: 'mcp' }).ok, false);
});

test('chain, allowlist, per-tx', () => {
  const e = { ...base, policy: pol };
  assert.equal(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.005, via: 'mcp' }).ok, true);
  assert.match(evaluate(e, { chain: 'arb', to: '0x000000000000000000000000000000000000dead', amount: 0.005, via: 'mcp' }).reasons[0], /chain arb not in policy/);
  assert.match(evaluate(e, { chain: 'base', to: '0x1111111111111111111111111111111111111111', amount: 0.005, via: 'mcp' }).reasons[0], /not in allowlist/);
  assert.match(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.02, via: 'mcp' }).reasons[0], /per-tx/);
  // wildcard limit applies to sol-devnet; allowlist is address based, Solana addr not listed -> denied
  assert.match(evaluate(e, { chain: 'sol-devnet', to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: 0.1, via: 'mcp' }).reasons[0], /allowlist/);
});

test('daily window counts sent + pending, not failed/denied', () => {
  const e = { ...base, policy: pol };
  appendLedger({ attempt: 'a1', wallet: 7, chain: 'base', amount: 0.01, status: 'pending' });
  appendLedger({ attempt: 'a1', wallet: 7, chain: 'base', amount: 0.01, status: 'sent' });
  appendLedger({ attempt: 'a2', wallet: 7, chain: 'base', amount: 0.01, status: 'pending' });
  appendLedger({ attempt: 'a3', wallet: 7, chain: 'base', amount: 0.01, status: 'failed' });
  appendLedger({ attempt: 'a4', wallet: 7, chain: 'base', amount: 0.01, status: 'denied' });
  appendLedger({ attempt: 'a5', wallet: 8, chain: 'base', amount: 0.01, status: 'sent' });
  assert.equal(spentInWindow(7, 'base'), 0.02);
  const r = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.01, via: 'mcp' });
  assert.equal(r.ok, true);
  const r2 = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.0101, via: 'mcp' });
  assert.match(r2.reasons.join(), /daily limit/);
});
