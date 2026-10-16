import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.WV_LEDGER = join(mkdtempSync(join(tmpdir(), 'wvl-')), 'ledger.jsonl');
const { executeSend } = await import('../src/ops.mjs');
const { history } = await import('../src/ledger.mjs');

test('concurrent sends cannot both pass the daily limit', async () => {
  const entry = { id: 1, label: 'bot', chains: ['evm'], addresses: { evm: '0xA' },
    policy: { chains: ['base'], allow: [], limits: { base: { perTx: 0.01, perDay: 0.015 } }, agent: true } };
  const mk = () => ({ to: '0x000000000000000000000000000000000000dEaD', amount: '0.01', _exec: async () => { await new Promise(r => setTimeout(r, 30)); return '0xhash (success)'; } });
  const results = await Promise.allSettled([
    executeSend({ entry, chain: 'base', via: 'mcp', preview: mk() }),
    executeSend({ entry, chain: 'base', via: 'mcp', preview: mk() }),
    executeSend({ entry, chain: 'base', via: 'mcp', preview: mk() }),
  ]);
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const denied = results.filter(r => r.status === 'rejected' && r.reason.denied).length;
  assert.equal(ok, 1);
  assert.equal(denied, 2);
  const h = history(1, 10);
  assert.equal(h.filter(r => r.status === 'sent').length, 1);
  assert.equal(h.filter(r => r.status === 'denied').length, 2);
});
