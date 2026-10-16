import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WV_LEDGER = join(mkdtempSync(join(tmpdir(), 'wvl-')), 'ledger.jsonl');
const { deriveKey, emptyVault, signPolicy, encrypt, entryAad, setLedgerMeta } = await import('../src/vault.mjs');
const vault = emptyVault();
const key = deriveKey('unit test passphrase', vault.kdf.salt);
setLedgerMeta(key, vault, { started: false });
const signed = (e) => { e.enc ||= encrypt(key, '{}', entryAad(e.id)); signPolicy(key, e); return e; };
const markStarted = () => {};
const { evaluate } = await import('../src/policy.mjs');
const { appendLedger, spentInWindow, verifyLedger, withLedgerLock } = await import('../src/ledger.mjs');

const base = { id: 7, label: 'bot', chains: ['evm', 'sol'], addresses: { evm: '0xA', sol: 'S' } };
const pol = { chains: ['base', 'sol-devnet'], allow: ['0x000000000000000000000000000000000000dEaD'], limits: { base: { perTx: 0.01, perDay: 0.03 }, '*': { perTx: 0.5, perDay: 1 } }, agent: true };

test('no policy: cli ok, mcp denied', () => {
  assert.equal(evaluate(base, { chain: 'base', to: '0x1', amount: 1, via: 'cli', key, vault }).ok, true);
  assert.equal(evaluate(base, { chain: 'base', to: '0x1', amount: 1, via: 'mcp', key, vault }).ok, false);
});

test('chain, allowlist, per-tx', () => {
  const e = signed({ ...base, policy: structuredClone(pol) });
  assert.equal(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.005, via: 'mcp', key, vault }).ok, true);
  assert.match(evaluate(e, { chain: 'arb', to: '0x000000000000000000000000000000000000dead', amount: 0.005, via: 'mcp', key, vault }).reasons[0], /chain arb not in policy/);
  assert.match(evaluate(e, { chain: 'base', to: '0x1111111111111111111111111111111111111111', amount: 0.005, via: 'mcp', key, vault }).reasons[0], /not in allowlist/);
  assert.match(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.02, via: 'mcp', key, vault }).reasons[0], /per-tx/);
  // wildcard limit applies to sol-devnet; allowlist is address based, Solana addr not listed -> denied
  assert.match(evaluate(e, { chain: 'sol-devnet', to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: 0.1, via: 'mcp', key, vault }).reasons[0], /allowlist/);
});

test('daily window counts sent + pending, not failed/denied', () => {
  for (const r of [
    { attempt: 'a1', wallet: 7, chain: 'base', amount: 0.01, status: 'pending' },
    { attempt: 'a1', wallet: 7, chain: 'base', amount: 0.01, status: 'sent' },
    { attempt: 'a2', wallet: 7, chain: 'base', amount: 0.01, status: 'pending' },
    { attempt: 'a3', wallet: 7, chain: 'base', amount: 0.01, status: 'failed' },
    { attempt: 'a4', wallet: 7, chain: 'base', amount: 0.01, status: 'denied' },
    { attempt: 'a5', wallet: 8, chain: 'base', amount: 0.01, status: 'sent' },
  ]) appendLedger(r, key, vault, markStarted);
  assert.equal(verifyLedger(key, vault).ok, true);
  assert.equal(spentInWindow(7, 'base'), 0.02);
  const e = signed({ ...base, policy: structuredClone(pol) });
  const r = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.01, via: 'mcp', key, vault });
  assert.equal(r.ok, true);
  const r2 = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.0101, via: 'mcp', key, vault });
  assert.match(r2.reasons.join(), /daily limit/);
});

test('tampering is detected: edited policy, truncated ledger, edited record', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const e = signed({ ...base, id: 9, policy: structuredClone(pol) });
  e.policy.limits.base.perTx = 100;   // agent edits vault.json to loosen its limit
  const r = evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 50, via: 'mcp', key, vault });
  assert.match(r.reasons.join(), /policy signature invalid/);
  const path = process.env.WV_LEDGER;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  writeFileSync(path, lines.slice(0, -1).join('\n') + '\n');           // truncate
  assert.match(verifyLedger(key, vault).reason, /truncated/);
  assert.throws(() => appendLedger({ attempt: 'x', wallet: 7, chain: 'base', amount: 0.01, status: 'sent' }, key, vault, markStarted), /integrity/);
  const last = JSON.parse(lines[lines.length - 1]); last.amount = 0; lines[lines.length - 1] = JSON.stringify(last);
  writeFileSync(path, lines.join('\n') + '\n');                        // edit a record
  assert.match(verifyLedger(key, vault).reason, /fails its MAC/);
  const e2 = signed({ ...base, policy: structuredClone(pol) });
  const r2 = evaluate(e2, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.001, via: 'mcp', key, vault });
  assert.match(r2.reasons.join(), /ledger integrity/);
});

test('deleting both ledger files is detected once the epoch has a ledger', async () => {
  const { rmSync } = await import('node:fs');
  rmSync(process.env.WV_LEDGER); rmSync(process.env.WV_LEDGER + '.head');
  assert.match(verifyLedger(key, vault).reason, /deleted/);
  const e = signed({ ...base, id: 11, policy: structuredClone(pol) });
  assert.match(evaluate(e, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.001, via: 'mcp', key, vault }).reasons.join(), /ledger integrity/);
});

test('policy MAC binds addresses and ciphertext (cannot move a policy onto another wallet)', () => {
  const e = signed({ ...base, id: 12, policy: structuredClone(pol) });
  const moved = { ...e, addresses: { evm: '0xTREASURY', sol: 'T' } };
  assert.match(evaluate(moved, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.001, via: 'mcp', key, vault }).reasons.join(), /policy signature invalid/);
  const swapped = { ...e, enc: encrypt(key, '{"other":1}', entryAad(12)) };
  assert.match(evaluate(swapped, { chain: 'base', to: '0x000000000000000000000000000000000000dead', amount: 0.001, via: 'mcp', key, vault }).reasons.join(), /policy signature invalid/);
});

test('forging the vault ledger flag is detected; rotation drops tampered policies', async () => {
  const { rotatePassphrase, verifyPolicy } = await import('../src/vault.mjs');
  const v2 = emptyVault(); const k2 = deriveKey('another passphrase!', v2.kdf.salt); setLedgerMeta(k2, v2, { started: true });
  v2.ledgerMeta.started = false;                       // attacker flips the flag to pretend no ledger existed
  assert.match(verifyLedger(k2, v2).reason, /forged/);
  setLedgerMeta(k2, v2, { started: false });
  const good = { id: 1, label: 'g', chains: ['evm'], addresses: { evm: '0x1' }, policy: { chains: ['base'], allow: [], limits: { base: { perTx: 1 } }, agent: true } };
  good.enc = encrypt(k2, '{}', entryAad(1)); signPolicy(k2, good);
  const bad = { id: 2, label: 'b', chains: ['evm'], addresses: { evm: '0x2' }, policy: { chains: ['base'], allow: [], limits: { base: { perTx: 1 } }, agent: true }, policyMac: 'ff' };
  bad.enc = encrypt(k2, '{}', entryAad(2));
  v2.entries = [good, bad];
  const { newKey, droppedPolicies } = rotatePassphrase(v2, k2, 'rotated passphrase!!');
  assert.deepEqual(droppedPolicies, ['b']);
  assert.equal(verifyPolicy(newKey, v2.entries[0]), true);
  assert.equal(v2.entries[1].policy, undefined);
});
