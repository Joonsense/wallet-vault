// Key derivation for EVM (secp256k1, BIP-44 m/44'/60'/0'/0/i) and Solana (ed25519, SLIP-0010 m/44'/501'/i'/0').
// One mnemonic covers both chains. All EVM mainnets (Ethereum, Base, Arbitrum, BNB, ...) share the EVM key.
import { generateMnemonic as scureGenerate, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { HDKey as Slip10 } from 'micro-key-producer/slip10.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const CHAINS = ['evm', 'sol'];

export function generateMnemonic(words = 24) {
  const strength = { 12: 128, 15: 160, 18: 192, 21: 224, 24: 256 }[words];
  if (!strength) throw new Error('words must be 12, 15, 18, 21 or 24');
  return scureGenerate(wordlist, strength);
}

export function isValidMnemonic(m) {
  return validateMnemonic(m.trim().toLowerCase().split(/\s+/).join(' '), wordlist);
}

export function normalizeMnemonic(m) {
  const n = m.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(n, wordlist)) throw new Error('invalid mnemonic (checksum or word list)');
  return n;
}

export function evmFromMnemonic(mnemonic, index = 0) {
  const acct = mnemonicToAccount(mnemonic, { addressIndex: index });
  const pk = acct.getHdKey().privateKey;
  return { address: acct.address, privateKey: '0x' + bytesToHex(pk), path: `m/44'/60'/0'/0/${index}` };
}

export function evmFromPrivateKey(pkHex) {
  const pk = pkHex.startsWith('0x') ? pkHex : '0x' + pkHex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('EVM private key must be 32 bytes hex');
  return { address: privateKeyToAccount(pk).address, privateKey: pk.toLowerCase(), path: null };
}

export function solFromMnemonic(mnemonic, index = 0) {
  const seed = mnemonicToSeedSync(mnemonic);
  const path = `m/44'/501'/${index}'/0'`;
  const node = Slip10.fromMasterSeed(seed).derive(path);
  return solFromSeed32(node.privateKey, path);
}

function solFromSeed32(seed32, path = null) {
  const pub = ed25519.getPublicKey(seed32);
  const secret64 = new Uint8Array(64);
  secret64.set(seed32, 0); secret64.set(pub, 32);
  return { address: base58.encode(pub), secretKey: base58.encode(secret64), path };
}

/** Accepts Phantom/solana-keygen style base58 64 byte key, base58 32 byte seed, or JSON byte array. */
export function solFromSecretKey(input) {
  let bytes;
  const s = input.trim();
  if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
  else if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) bytes = hexToBytes(s.replace(/^0x/, ''));
  else bytes = base58.decode(s);
  if (bytes.length === 64) bytes = bytes.slice(0, 32);
  if (bytes.length !== 32) throw new Error('Solana key must be 32 byte seed or 64 byte secret key');
  return solFromSeed32(bytes);
}

/** Build { addresses, secret } for a fresh or imported mnemonic. */
export function walletFromMnemonic(mnemonic, chains = CHAINS, index = 0) {
  const m = normalizeMnemonic(mnemonic);
  const addresses = {}, secret = { kind: 'mnemonic', mnemonic: m, index };
  if (chains.includes('evm')) { const e = evmFromMnemonic(m, index); addresses.evm = e.address; secret.evmPrivateKey = e.privateKey; }
  if (chains.includes('sol')) { const s = solFromMnemonic(m, index); addresses.sol = s.address; secret.solSecretKey = s.secretKey; }
  return { addresses, secret };
}
