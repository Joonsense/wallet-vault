// Encrypted local vault. One file, AES-256-GCM per entry, scrypt-derived key.
// Nothing here ever prints a secret; callers decide what to reveal.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const VAULT_VERSION = 1;
export const DEFAULT_VAULT_PATH = process.env.WV_VAULT || join(homedir(), '.wallet-vault', 'vault.json');

const KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1, dkLen: 32 };
const CHECK_PLAINTEXT = 'wallet-vault-check-v1';

function b64(u8) { return Buffer.from(u8).toString('base64'); }
function unb64(s) { return Buffer.from(s, 'base64'); }

export function deriveKey(passphrase, saltB64, kdf = KDF) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('passphrase must be at least 8 characters');
  }
  return scryptSync(Buffer.from(passphrase.normalize('NFKD'), 'utf8'), unb64(saltB64), kdf.dkLen, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024,
  });
}

export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}

export function decrypt(key, box) {
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(box.iv));
  decipher.setAuthTag(unb64(box.tag));
  return Buffer.concat([decipher.update(unb64(box.ct)), decipher.final()]).toString('utf8');
}

export function emptyVault() {
  return {
    version: VAULT_VERSION,
    createdAt: new Date().toISOString(),
    kdf: { ...KDF, salt: b64(randomBytes(32)) },
    check: null,       // encrypted CHECK_PLAINTEXT, used to verify the passphrase quickly
    nextId: 1,
    entries: [],
  };
}

export function loadVaultFile(path = DEFAULT_VAULT_PATH) {
  if (!existsSync(path)) return null;
  const v = JSON.parse(readFileSync(path, 'utf8'));
  if (v.version !== VAULT_VERSION) throw new Error(`unsupported vault version ${v.version}`);
  return v;
}

export function saveVaultFile(vault, path = DEFAULT_VAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(vault, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function backupVaultFile(dest, path = DEFAULT_VAULT_PATH) {
  if (!existsSync(path)) throw new Error('no vault to back up');
  copyFileSync(path, dest);
  chmodSync(dest, 0o600);
}

/** Open (or create) a vault with a passphrase. Returns { vault, key, path, created }. */
export function openVault(passphrase, path = DEFAULT_VAULT_PATH) {
  let vault = loadVaultFile(path);
  let created = false;
  if (!vault) {
    vault = emptyVault();
    created = true;
  }
  const key = deriveKey(passphrase, vault.kdf.salt, vault.kdf);
  if (vault.check) {
    let ok = false;
    try {
      const pt = decrypt(key, vault.check);
      ok = pt.length === CHECK_PLAINTEXT.length && timingSafeEqual(Buffer.from(pt), Buffer.from(CHECK_PLAINTEXT));
    } catch { ok = false; }
    if (!ok) throw new Error('wrong passphrase');
  } else {
    vault.check = encrypt(key, CHECK_PLAINTEXT);
    saveVaultFile(vault, path);
  }
  return { vault, key, path, created };
}

export function findEntry(vault, ref) {
  const byId = vault.entries.find(e => String(e.id) === String(ref));
  if (byId) return byId;
  const byLabel = vault.entries.filter(e => e.label === ref);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) throw new Error(`label "${ref}" is ambiguous, use the id`);
  const byAddr = vault.entries.filter(e => Object.values(e.addresses || {}).some(a => a.toLowerCase() === String(ref).toLowerCase()));
  if (byAddr.length === 1) return byAddr[0];
  throw new Error(`no wallet matching "${ref}"`);
}

/** Add an entry. secret = { kind: 'mnemonic'|'raw', mnemonic?, evmPrivateKey?, solSecretKey? } */
export function addEntry(vault, key, { label, chains, addresses, secret, note }) {
  const entry = {
    id: vault.nextId++,
    label: label || `wallet-${vault.nextId - 1}`,
    chains,
    addresses,
    note: note || '',
    createdAt: new Date().toISOString(),
    enc: encrypt(key, JSON.stringify(secret)),
  };
  vault.entries.push(entry);
  return entry;
}

export function readSecret(entry, key) {
  return JSON.parse(decrypt(key, entry.enc));
}

export function removeEntry(vault, entry) {
  vault.entries = vault.entries.filter(e => e.id !== entry.id);
}

/** Re-encrypt every entry under a new passphrase. */
export function rotatePassphrase(vault, oldKey, newPassphrase) {
  const fresh = emptyVault();
  const newKey = deriveKey(newPassphrase, fresh.kdf.salt, fresh.kdf);
  vault.entries = vault.entries.map(e => ({ ...e, enc: encrypt(newKey, decrypt(oldKey, e.enc)) }));
  vault.kdf = fresh.kdf;
  vault.check = encrypt(newKey, CHECK_PLAINTEXT);
  return newKey;
}

// ---- Integrity: policy + ledger are plaintext metadata, so they are authenticated with a subkey of the vault key.
// An agent process with file access (same user) cannot loosen its own policy or truncate the ledger without the passphrase.
// Known limit: a full rollback (restoring older vault.json + ledger + ledger.head together) is not detected.
export function macKey(key, purpose) {
  return createHmac('sha256', key).update(`wallet-vault:${purpose}`).digest();
}
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export function hmacHex(subkey, data) {
  return createHmac('sha256', subkey).update(data).digest('hex');
}
export function signPolicy(key, entry) {
  if (!entry.policy) { delete entry.policyMac; return; }
  entry.policyMac = hmacHex(macKey(key, 'policy'), stableStringify({ id: entry.id, policy: entry.policy }));
}
export function verifyPolicy(key, entry) {
  if (!entry.policy) return !entry.policyMac;
  if (!entry.policyMac) return false;
  const want = hmacHex(macKey(key, 'policy'), stableStringify({ id: entry.id, policy: entry.policy }));
  const a = Buffer.from(want, 'hex'), b = Buffer.from(String(entry.policyMac), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
