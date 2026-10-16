// Append-only spend ledger next to the vault. Plain JSON lines, no secrets (addresses + amounts + tx hashes).
// Every record carries an HMAC chained to the previous one; the chain head is anchored in ledger.head. Both use a
// subkey of the vault key, so a process without the passphrase cannot forge, edit or truncate the ledger unnoticed.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { DEFAULT_VAULT_PATH, macKey, hmacHex, stableStringify } from './vault.mjs';

export const LEDGER_PATH = process.env.WV_LEDGER || join(dirname(DEFAULT_VAULT_PATH), 'ledger.jsonl');
const HEAD_PATH = `${LEDGER_PATH}.head`;
const genesisFor = (vault) => `genesis:${vault.ledgerEpoch}`;

function recordMac(subkey, prevMac, rec) {
  const { mac, ...body } = rec;
  return hmacHex(subkey, prevMac + '\n' + stableStringify(body));
}
function headSig(subkey, vault, count, mac) { return hmacHex(subkey, `head:${vault.ledgerEpoch}:${count}:${mac}`); }
function eq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }

function rawRecords() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { _corrupt: l }; } });
}
function readHead() {
  if (!existsSync(HEAD_PATH)) return null;
  try { return JSON.parse(readFileSync(HEAD_PATH, 'utf8')); } catch { return { _corrupt: true }; }
}

/** Verify chain + head against this vault's epoch. Returns { ok, reason, records, count, head }. */
export function verifyLedger(key, vault) {
  if (!vault?.ledgerEpoch) return { ok: false, reason: 'vault has no ledger epoch', records: [], count: 0, head: null };
  const sub = macKey(key, 'ledger');
  const records = rawRecords();
  const head = readHead();
  let prev = genesisFor(vault);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r._corrupt) return { ok: false, reason: `line ${i + 1} is not JSON`, records, count: records.length, head };
    if (!r.mac || !eq(recordMac(sub, prev, r), r.mac)) return { ok: false, reason: `record ${i + 1} (${r.attempt || '?'}) fails its MAC`, records, count: records.length, head };
    prev = r.mac;
  }
  if (!head) {
    // No head at all: only acceptable while the ledger has never been written in this epoch.
    if (records.length === 0 && !existsSync(LEDGER_PATH)) return { ok: !vault.ledgerStarted, reason: vault.ledgerStarted ? 'ledger files deleted (vault says this epoch has a ledger)' : null, records, count: 0, head: null };
    return { ok: false, reason: 'ledger has records but ledger.head is missing', records, count: records.length, head };
  }
  if (head._corrupt || !eq(headSig(sub, vault, head.count, head.mac), head.sig)) return { ok: false, reason: 'ledger.head signature invalid (wrong vault epoch or edited)', records, count: records.length, head };
  if (head.count !== records.length || !eq(head.mac, prev)) return { ok: false, reason: `ledger truncated or edited (head says ${head.count} records, file has ${records.length})`, records, count: records.length, head };
  return { ok: true, reason: null, records, count: records.length, head };
}

/**
 * Append one record (call under the ledger lock). Refuses to extend a ledger that fails verification.
 * First write of an epoch marks the vault (ledgerStarted, signed into every policy MAC via re-sign) so deleting the
 * ledger files later is detected. The marker is written through `markStarted(vault)` supplied by the caller.
 */
export function appendLedger(rec, key, vault, markStarted) {
  if (!key || !vault) throw new Error('appendLedger needs the vault key and vault');
  const sub = macKey(key, 'ledger');
  const v = verifyLedger(key, vault);
  if (!v.ok) throw new Error(`ledger integrity failure: ${v.reason} (inspect ${LEDGER_PATH}; wv ledger verify)`);
  if (!vault.ledgerStarted) {
    if (typeof markStarted !== 'function') throw new Error('first ledger write needs markStarted');
    markStarted(vault); // sets vault.ledgerStarted = true, re-signs policies, saves vault.json
  }
  const prev = v.count ? v.records[v.count - 1].mac : genesisFor(vault);
  const body = { ts: new Date().toISOString(), ...rec };
  const mac = recordMac(sub, prev, body);
  mkdirSync(dirname(LEDGER_PATH), { recursive: true, mode: 0o700 });
  appendFileSync(LEDGER_PATH, JSON.stringify({ ...body, mac }) + '\n', { mode: 0o600 });
  const count = v.count + 1;
  const tmp = `${HEAD_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ count, mac, sig: headSig(sub, vault, count, mac) }), { mode: 0o600 });
  renameSync(tmp, HEAD_PATH);
  try { chmodSync(LEDGER_PATH, 0o600); } catch {}
}

/** Records for callers that already verified, or for display (unverified). */
export function readLedger() { return rawRecords().filter(r => !r._corrupt); }

/** Latest status per attempt id (pending -> sent | failed | unknown). */
export function resolvedAttempts(records) {
  const byId = new Map();
  for (const r of records) if (r.attempt) byId.set(r.attempt, { ...(byId.get(r.attempt) || {}), ...r });
  return [...byId.values()];
}

/** Budget use in the last windowMs: everything except verified failed/denied (sent, pending, unknown all count). */
export function spentInWindow(walletId, chain, windowMs = 86_400_000, now = Date.now(), records = readLedger()) {
  const since = now - windowMs;
  return resolvedAttempts(records)
    .filter(r => r.wallet === walletId && r.chain === chain && r.status !== 'failed' && r.status !== 'denied' && Date.parse(r.ts) >= since)
    .reduce((s, r) => s + Number(r.amount || 0), 0);
}

export function history(walletId, limit = 20) {
  return resolvedAttempts(readLedger()).filter(r => walletId == null || r.wallet === walletId).slice(-limit).reverse();
}

// ---- Cross-process lock. mkdir is atomic; a stale lock is taken over by an atomic rename (only one taker wins) and a
// lock is only ever released by the process that owns it (token check).
const LOCK_DIR = `${LEDGER_PATH}.lock`;
const STALE_MS = 30_000;
let queue = Promise.resolve();
let myToken = null;

function acquire(timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      myToken = `${process.pid}-${randomBytes(8).toString('hex')}`;
      writeFileSync(join(LOCK_DIR, 'owner'), myToken);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS) {
          const tomb = `${LOCK_DIR}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
          renameSync(LOCK_DIR, tomb);            // atomic: exactly one waiter succeeds
          rmSync(tomb, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) throw new Error('ledger lock timeout (another send in progress?)');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
function release() {
  try {
    const owner = readFileSync(join(LOCK_DIR, 'owner'), 'utf8');
    if (owner === myToken) rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {}
  myToken = null;
}

/** Run fn with the ledger lock held. fn must be quick (no network). */
export function withLedgerLock(fn) {
  const run = queue.then(async () => { mkdirSync(dirname(LEDGER_PATH), { recursive: true, mode: 0o700 }); acquire(); try { return await fn(); } finally { release(); } });
  queue = run.catch(() => {});
  return run;
}
