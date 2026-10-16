// Append-only spend ledger next to the vault. Plain JSON lines, no secrets (addresses + amounts + tx hashes).
import { appendFileSync, readFileSync, existsSync, mkdirSync, chmodSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_VAULT_PATH } from './vault.mjs';

export const LEDGER_PATH = process.env.WV_LEDGER || join(dirname(DEFAULT_VAULT_PATH), 'ledger.jsonl');

export function appendLedger(rec) {
  mkdirSync(dirname(LEDGER_PATH), { recursive: true, mode: 0o700 });
  appendFileSync(LEDGER_PATH, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', { mode: 0o600 });
  try { chmodSync(LEDGER_PATH, 0o600); } catch {}
}

export function readLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Latest status per attempt id (pending -> sent | failed). */
export function resolvedAttempts(records) {
  const byId = new Map();
  for (const r of records) if (r.attempt) byId.set(r.attempt, { ...(byId.get(r.attempt) || {}), ...r });
  return [...byId.values()];
}

/** Sum of amounts that count against the budget in the last `windowMs`: sent + still pending. */
export function spentInWindow(walletId, chain, windowMs = 86_400_000, now = Date.now()) {
  const since = now - windowMs;
  return resolvedAttempts(readLedger())
    .filter(r => r.wallet === walletId && r.chain === chain && r.status !== 'failed' && r.status !== 'denied' && Date.parse(r.ts) >= since)
    .reduce((s, r) => s + Number(r.amount || 0), 0);
}

export function history(walletId, limit = 20) {
  return resolvedAttempts(readLedger()).filter(r => walletId == null || r.wallet === walletId).slice(-limit).reverse();
}

// Cross-process lock (mkdir is atomic on POSIX) + in-process queue, so check-and-reserve is atomic across CLI and MCP.
const LOCK_DIR = `${LEDGER_PATH}.lock`;
const STALE_MS = 30_000;
let queue = Promise.resolve();

function acquire(timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try { mkdirSync(LOCK_DIR); return; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS) { rmdirSync(LOCK_DIR); continue; } } catch {}
      if (Date.now() - start > timeoutMs) throw new Error('ledger lock timeout (another send in progress?)');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
function release() { try { rmdirSync(LOCK_DIR); } catch {} }

/** Run fn with the ledger lock held. fn must be quick (no network). */
export function withLedgerLock(fn) {
  const run = queue.then(async () => { mkdirSync(dirname(LEDGER_PATH), { recursive: true, mode: 0o700 }); acquire(); try { return await fn(); } finally { release(); } });
  queue = run.catch(() => {});
  return run;
}
