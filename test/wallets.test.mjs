import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evmFromMnemonic, solFromMnemonic, generateMnemonic, isValidMnemonic, solFromSecretKey, evmFromPrivateKey } from '../src/wallets.mjs';
import { emptyVault, deriveKey, encrypt, decrypt, addEntry, readSecret, rotatePassphrase } from '../src/vault.mjs';

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('EVM BIP-44 vector', () => {
  const w = evmFromMnemonic(M, 0);
  assert.equal(w.address, '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.equal(evmFromPrivateKey(w.privateKey).address, w.address);
});

test('Solana SLIP-0010 vector (Phantom path)', () => {
  const w = solFromMnemonic(M, 0);
  assert.equal(w.address, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(solFromSecretKey(w.secretKey).address, w.address);
});

test('fresh mnemonics are valid and distinct', () => {
  const a = generateMnemonic(24), b = generateMnemonic(12);
  assert.ok(isValidMnemonic(a) && isValidMnemonic(b));
  assert.notEqual(a, b);
  assert.equal(a.split(' ').length, 24);
});

test('vault encrypt/decrypt + rotate', () => {
  const v = emptyVault();
  const k = deriveKey('correct horse battery', v.kdf.salt, v.kdf);
  const e = addEntry(v, k, { label: 't', chains: ['evm'], addresses: { evm: '0x1' }, secret: { kind: 'raw', evmPrivateKey: '0xabc' } });
  assert.equal(readSecret(e, k).evmPrivateKey, '0xabc');
  const bad = deriveKey('wrong wrong wrong', v.kdf.salt, v.kdf);
  assert.throws(() => decrypt(bad, e.enc));
  const k2 = rotatePassphrase(v, k, 'new passphrase here');
  assert.equal(readSecret(v.entries[0], k2).evmPrivateKey, '0xabc');
  assert.throws(() => decrypt(k, v.entries[0].enc));
  assert.equal(decrypt(k2, v.check), 'wallet-vault-check-v1');
});
