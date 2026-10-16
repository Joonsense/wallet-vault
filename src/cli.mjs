#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { DEFAULT_VAULT_PATH, openVault, saveVaultFile, findEntry, addEntry, readSecret, removeEntry, rotatePassphrase, backupVaultFile } from './vault.mjs';
import { CHAINS, generateMnemonic, walletFromMnemonic, evmFromPrivateKey, solFromSecretKey, evmFromMnemonic, solFromMnemonic } from './wallets.mjs';
import { getPassphrase, visiblePrompt } from './prompt.mjs';

const HELP = `wv - local encrypted wallet vault (EVM + Solana)

  wv new [label] [--chain evm|sol|all] [--words 12|24] [--count N] [--note "..."]
  wv list [--json]
  wv show <id|label|address> [--index N]
  wv export <id|label> (--mnemonic | --evm | --sol) [--index N] [--yes]
  wv env <id|label> [--index N]            # eval "$(wv env trader1)" -> EVM_PRIVATE_KEY, SOL_SECRET_KEY
  wv import <label> (--mnemonic "..." | --evm 0x... | --sol <base58|json>) [--chain ...]
  wv rename <id|label> <new-label>
  wv rm <id|label> [--yes]
  wv passwd                                # rotate vault passphrase
  wv backup <dest-file>
  wv path                                  # vault location

  Vault: ${DEFAULT_VAULT_PATH}  (override with WV_VAULT)
  Passphrase: prompted, or WV_PASSPHRASE env (put it in .env, never commit).
  Secrets print only on export/env, to stdout, with a warning on stderr.`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chain: { type: 'string', default: 'all' },
    words: { type: 'string', default: '24' },
    count: { type: 'string', default: '1' },
    index: { type: 'string', default: '0' },
    note: { type: 'string' },
    mnemonic: { type: 'boolean' },
    evm: { type: 'boolean' },
    sol: { type: 'boolean' },
    json: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
  // for import, --mnemonic/--evm/--sol take a value; handled manually below
  strict: false,
});

const [cmd, ...args] = positionals;
const err = (m) => { process.stderr.write(`error: ${m}\n`); process.exit(1); };
const warn = (m) => process.stderr.write(`${m}\n`);

function chainsFromOpt() {
  if (opt.chain === 'all') return [...CHAINS];
  const c = String(opt.chain).split(',').map(s => s.trim());
  for (const x of c) if (!CHAINS.includes(x)) err(`unknown chain "${x}" (evm, sol)`);
  return c;
}

function fmtEntry(e) {
  return `#${e.id}  ${e.label.padEnd(16)}  evm ${e.addresses.evm || '-'}  sol ${e.addresses.sol || '-'}  ${e.createdAt.slice(0, 10)}${e.note ? '  ' + e.note : ''}`;
}

async function open({ confirm = false } = {}) {
  const pass = await getPassphrase({ confirm });
  return openVault(pass);
}

async function confirmReveal(what) {
  if (opt.yes) return;
  const a = await visiblePrompt(`Reveal ${what}? type "reveal" to continue: `);
  if (a !== 'reveal') err('aborted');
}

async function main() {
  if (!cmd || opt.help) { console.log(HELP); return; }

  if (cmd === 'path') { console.log(DEFAULT_VAULT_PATH); return; }

  if (cmd === 'new') {
    const label = args[0];
    const chains = chainsFromOpt();
    const words = Number(opt.words), count = Number(opt.count);
    const { vault, key, created } = await open({ confirm: !existsVault() });
    if (created) warn(`created new vault at ${DEFAULT_VAULT_PATH}`);
    for (let i = 0; i < count; i++) {
      const mnemonic = generateMnemonic(words);
      const { addresses, secret } = walletFromMnemonic(mnemonic, chains, 0);
      const e = addEntry(vault, key, { label: count > 1 && label ? `${label}-${i + 1}` : label, chains, addresses, secret, note: opt.note });
      console.log(fmtEntry(e));
    }
    saveVaultFile(vault);
    warn(`saved. mnemonic (${words} words) is encrypted in the vault; "wv export <id> --mnemonic" to back it up offline.`);
    return;
  }

  if (cmd === 'list') {
    const { vault } = await open();
    if (opt.json) { console.log(JSON.stringify(vault.entries.map(({ enc, ...e }) => e), null, 2)); return; }
    if (!vault.entries.length) { console.log('(empty)'); return; }
    vault.entries.forEach(e => console.log(fmtEntry(e)));
    return;
  }

  if (cmd === 'show') {
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    const idx = Number(opt.index);
    if (idx === 0) { console.log(fmtEntry(e)); return; }
    const s = readSecret(e, key);
    if (s.kind !== 'mnemonic') err('raw key wallets have no derivation index');
    const out = { id: e.id, label: e.label, index: idx };
    if (e.chains.includes('evm')) out.evm = evmFromMnemonic(s.mnemonic, idx).address;
    if (e.chains.includes('sol')) out.sol = solFromMnemonic(s.mnemonic, idx).address;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'export') {
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    const s = readSecret(e, key);
    const idx = Number(opt.index);
    if (opt.mnemonic) {
      if (s.kind !== 'mnemonic') err('this wallet was imported from a raw key, no mnemonic');
      await confirmReveal(`mnemonic of #${e.id} ${e.label}`);
      warn('!! mnemonic follows. anyone with it owns every chain of this wallet.');
      console.log(s.mnemonic);
    } else if (opt.evm) {
      if (!e.chains.includes('evm')) err('no evm key in this wallet');
      await confirmReveal(`EVM private key of #${e.id} ${e.label}`);
      const pk = idx === 0 || s.kind !== 'mnemonic' ? s.evmPrivateKey : evmFromMnemonic(s.mnemonic, idx).privateKey;
      warn('!! EVM private key follows.');
      console.log(pk);
    } else if (opt.sol) {
      if (!e.chains.includes('sol')) err('no solana key in this wallet');
      await confirmReveal(`Solana secret key of #${e.id} ${e.label}`);
      const sk = idx === 0 || s.kind !== 'mnemonic' ? s.solSecretKey : solFromMnemonic(s.mnemonic, idx).secretKey;
      warn('!! Solana secret key (base58, 64 bytes, Phantom import format) follows.');
      console.log(sk);
    } else err('choose --mnemonic, --evm or --sol');
    return;
  }

  if (cmd === 'env') {
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    const s = readSecret(e, key);
    const idx = Number(opt.index);
    const lines = [];
    if (e.chains.includes('evm')) {
      const pk = idx === 0 || s.kind !== 'mnemonic' ? s.evmPrivateKey : evmFromMnemonic(s.mnemonic, idx).privateKey;
      const addr = idx === 0 || s.kind !== 'mnemonic' ? e.addresses.evm : evmFromMnemonic(s.mnemonic, idx).address;
      lines.push(`export EVM_PRIVATE_KEY=${pk}`, `export EVM_ADDRESS=${addr}`);
    }
    if (e.chains.includes('sol')) {
      const sk = idx === 0 || s.kind !== 'mnemonic' ? s.solSecretKey : solFromMnemonic(s.mnemonic, idx).secretKey;
      const addr = idx === 0 || s.kind !== 'mnemonic' ? e.addresses.sol : solFromMnemonic(s.mnemonic, idx).address;
      lines.push(`export SOL_SECRET_KEY=${sk}`, `export SOL_ADDRESS=${addr}`);
    }
    warn(`# secrets for #${e.id} ${e.label} exported to the current shell only`);
    console.log(lines.join('\n'));
    return;
  }

  if (cmd === 'import') {
    const label = args[0] ?? err('label required');
    const raw = rawFlag('mnemonic') ?? null, evmPk = rawFlag('evm') ?? null, solKey = rawFlag('sol') ?? null;
    const { vault, key, created } = await open({ confirm: !existsVault() });
    if (created) warn(`created new vault at ${DEFAULT_VAULT_PATH}`);
    let addresses = {}, secret, chains;
    if (raw) {
      chains = chainsFromOpt();
      ({ addresses, secret } = walletFromMnemonic(raw, chains, 0));
    } else {
      secret = { kind: 'raw' }; chains = [];
      if (evmPk) { const w = evmFromPrivateKey(evmPk); addresses.evm = w.address; secret.evmPrivateKey = w.privateKey; chains.push('evm'); }
      if (solKey) { const w = solFromSecretKey(solKey); addresses.sol = w.address; secret.solSecretKey = w.secretKey; chains.push('sol'); }
      if (!chains.length) err('give --mnemonic "..." or --evm 0x... or --sol <key>');
    }
    const dup = vault.entries.find(e => CHAINS.some(c => addresses[c] && e.addresses[c] === addresses[c]));
    if (dup) err(`already stored as #${dup.id} ${dup.label}`);
    const e = addEntry(vault, key, { label, chains, addresses, secret, note: opt.note });
    saveVaultFile(vault);
    console.log(fmtEntry(e));
    return;
  }

  if (cmd === 'rename') {
    const { vault } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    e.label = args[1] ?? err('new label required');
    saveVaultFile(vault);
    console.log(fmtEntry(e));
    return;
  }

  if (cmd === 'rm') {
    const { vault } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    if (!opt.yes) {
      const a = await visiblePrompt(`Delete #${e.id} ${e.label} (${e.addresses.evm || e.addresses.sol})? Funds on-chain are NOT affected but the key is gone forever. Type the label to confirm: `);
      if (a !== e.label) err('aborted');
    }
    removeEntry(vault, e);
    saveVaultFile(vault);
    warn(`removed #${e.id} ${e.label}`);
    return;
  }

  if (cmd === 'passwd') {
    const { vault, key } = await open();
    const next = await getPassphrase({ confirm: true, label: 'New passphrase' });
    rotatePassphrase(vault, key, next);
    saveVaultFile(vault);
    warn('passphrase rotated, all entries re-encrypted');
    return;
  }

  if (cmd === 'backup') {
    const dest = args[0] ?? err('destination path required');
    backupVaultFile(dest);
    warn(`vault copied to ${dest} (still encrypted; needs the passphrase)`);
    return;
  }

  err(`unknown command "${cmd}"\n${HELP}`);
}

// parseArgs with strict:false treats --mnemonic "x" as boolean + positional; recover the value here.
function rawFlag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}

function existsVault() { return existsSync(DEFAULT_VAULT_PATH); }

main().catch(e => err(e.message));
