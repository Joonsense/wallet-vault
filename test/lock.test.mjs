import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WV_LEDGER = join(mkdtempSync(join(tmpdir(), 'wvl-')), 'ledger.jsonl');
const { deriveKey, emptyVault, signPolicy, encrypt, entryAad, setLedgerMeta } = await import('../src/vault.mjs');
const vault = emptyVault();
const key = deriveKey('unit test passphrase', vault.kdf.salt);
setLedgerMeta(key, vault);
const { initLedger } = await import('../src/ledger.mjs');
initLedger(key, vault);
const signed = (e) => { e.enc ||= encrypt(key, '{}', entryAad(e.id)); signPolicy(key, e); return e; };
const { executeSend, reconcile } = await import('../src/ops.mjs');
const { history, spentInWindow } = await import('../src/ledger.mjs');

test('concurrent sends cannot both pass the daily limit', async () => {
  const entry = signed({ id: 1, label: 'bot', chains: ['evm'], addresses: { evm: '0xA' },
    policy: { chains: ['base'], allow: [], limits: { base: { perTx: 0.01, perDay: 0.015 } }, agent: true } });
  const mk = (h = '0xhash') => ({ to: '0x000000000000000000000000000000000000dEaD', amount: '0.01', _prepare: async () => ({ hash: h, send: async () => { await new Promise(r => setTimeout(r, 30)); return h + ' (success)'; } }) });
  const results = await Promise.allSettled([
    executeSend({ entry, key, vault, chain: 'base', via: 'mcp', preview: mk() }),
    executeSend({ entry, key, vault, chain: 'base', via: 'mcp', preview: mk() }),
    executeSend({ entry, key, vault, chain: 'base', via: 'mcp', preview: mk() }),
  ]);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const denied = results.filter(r => r.status === 'rejected' && r.reason.denied).length;
  assert.equal(ok, 1);
  assert.equal(denied, 2);
  const h = history(1, 10);
  assert.equal(h.filter(r => r.status === 'sent').length, 1);
  assert.equal(h.filter(r => r.status === 'denied').length, 2);
});

test('error after broadcast is recorded unknown and still counts; reconcile settles it', async () => {
  const entry = signed({ id: 2, label: 'bot2', chains: ['evm'], addresses: { evm: '0xA' },
    policy: { chains: ['base'], allow: [], limits: { base: { perTx: 0.01, perDay: 0.1 } }, agent: true } });
  const p = { to: '0x000000000000000000000000000000000000dEaD', amount: '0.01', _prepare: async () => ({ hash: '0xdead1', send: async () => { throw new Error('confirm timeout'); } }) };
  await assert.rejects(executeSend({ entry, key, vault, chain: 'base', via: 'mcp', preview: p }), /unknown/);
  assert.equal(history(2, 5)[0].status, 'unknown');
  assert.equal(spentInWindow(2, 'base'), 0.01);
  const r1 = await reconcile(history(2, 5), { txStatus: async () => 'notfound', key, vault });
  assert.equal(r1[0].after, 'unknown');                         // too young to write off
  const r2 = await reconcile(history(2, 5), { txStatus: async () => 'confirmed', key, vault });
  assert.equal(r2[0].after, 'sent');
  assert.equal(history(2, 5)[0].status, 'sent');
  assert.equal(spentInWindow(2, 'base'), 0.01);
  // a reverted one frees the budget
  const p2 = { ...p, _prepare: async () => ({ hash: '0xdead2', send: async () => { throw new Error('boom'); } }) };
  await assert.rejects(executeSend({ entry, key, vault, chain: 'base', via: 'mcp', preview: p2 }));
  await reconcile(history(2, 10), { txStatus: async (k, h) => (h === '0xdead2' ? 'reverted' : 'confirmed'), key, vault });
  assert.equal(spentInWindow(2, 'base'), 0.01);
});

test('token send with native side cost reserves a native row and needs a native limit', async () => {
  const { spentInWindow } = await import('../src/ledger.mjs');
  const mk = () => ({ to: 'Recv', amount: '1', tokenKey: 'USDC', nativeCost: 0.002, _prepare: async () => ({ hash: 'sig1', send: async () => 'sig1 (confirmed)' }) });
  const noNative = signed({ id: 30, label: 'spl', chains: ['sol'], addresses: { sol: 'S' }, policy: { chains: ['sol-devnet'], allow: [], limits: { 'sol-devnet:USDC': { perTx: 5, perDay: 10 } }, agent: true } });
  await assert.rejects(executeSend({ entry: noNative, key, vault, chain: 'sol-devnet', via: 'mcp', preview: mk() }), /native side cost/);
  const withNative = signed({ id: 31, label: 'spl2', chains: ['sol'], addresses: { sol: 'S' }, policy: { chains: ['sol-devnet'], allow: [], limits: { 'sol-devnet:USDC': { perTx: 5, perDay: 10 }, 'sol-devnet': { perTx: 0.01, perDay: 0.005 } }, agent: true } });
  await executeSend({ entry: withNative, key, vault, chain: 'sol-devnet', via: 'mcp', preview: mk() });
  assert.equal(spentInWindow(31, 'sol-devnet', 86_400_000, Date.now(), undefined, 'USDC'), 1);
  assert.equal(spentInWindow(31, 'sol-devnet'), 0.002);
  await executeSend({ entry: withNative, key, vault, chain: 'sol-devnet', via: 'mcp', preview: mk() });
  await assert.rejects(executeSend({ entry: withNative, key, vault, chain: 'sol-devnet', via: 'mcp', preview: mk() }), /daily limit 0.005/);  // third rent would exceed native budget
});
