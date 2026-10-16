#!/usr/bin/env -S node --no-deprecation
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { DEFAULT_VAULT_PATH, deriveKey, openVault, saveVaultFile, findEntry, addEntry, readSecret, removeEntry, rotatePassphrase, backupVaultFile } from './vault.mjs';
import { CHAINS, generateMnemonic, walletFromMnemonic, evmFromPrivateKey, solFromSecretKey, evmFromMnemonic, solFromMnemonic } from './wallets.mjs';
import { getPassphrase, hiddenPrompt, visiblePrompt } from './prompt.mjs';
import { resolveChainKeys, nativeBalance, previewSend, validateRecipient, symbolOf, explorerTx, ALL_KEYS } from './chains.mjs';

const HELP = `wv - local encrypted wallet vault (EVM + Solana)

  wv new [label] [--chain evm|sol|all] [--words 12|24] [--count N] [--note "..."]
  wv list [--json]
  wv show <id|label|address> [--index N]
  wv export <id|label> (--mnemonic | --evm | --sol) [--index N] [--yes]
  wv env <id|label> [--index N]            # eval "$(wv env trader1)" -> EVM_PRIVATE_KEY, SOL_SECRET_KEY
  wv balance <id|label> [--chain eth,base,arb,op,bnb,polygon,avax,sol|all] [--index N] [--json]
  wv send <id|label> --chain base --to 0x... --amount 0.01 [--index N] [--dry-run] [--yes]
  wv import <label> (--mnemonic | --evm | --sol) [--chain ...]   # secret is asked via hidden prompt, never argv
  wv rename <id|label> <new-label>
  wv rm <id|label> [--yes]
  wv passwd                                # rotate vault passphrase
  wv backup <dest-file>
  wv path                                  # vault location

  Chains: ${ALL_KEYS.join(' ')}   RPC override: WV_RPC_<CHAIN> (e.g. WV_RPC_BASE, WV_RPC_SOL)
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
    to: { type: 'string' },
    amount: { type: 'string' },
    'dry-run': { type: 'boolean' },
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

/** Addresses + secrets of an entry at a derivation index (0 = stored values). */
function materialize(e, s, idx) {
  const out = { evm: null, sol: null };
  if (e.chains.includes('evm')) {
    out.evm = idx === 0 || s.kind !== 'mnemonic'
      ? { address: e.addresses.evm, privateKey: s.evmPrivateKey }
      : evmFromMnemonic(s.mnemonic, idx);
  }
  if (e.chains.includes('sol')) {
    out.sol = idx === 0 || s.kind !== 'mnemonic'
      ? { address: e.addresses.sol, secretKey: s.solSecretKey }
      : solFromMnemonic(s.mnemonic, idx);
  }
  return out;
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

  if (cmd === 'balance') {
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    const idx = Number(opt.index);
    const keys = resolveChainKeys(opt.chain === 'all' ? null : opt.chain).filter(k => (k === 'sol' ? e.chains.includes('sol') : e.chains.includes('evm')));
    if (!keys.length) err('this wallet has no key for the requested chains');
    // address only; no secret needed unless index > 0
    const w = idx === 0 ? { evm: { address: e.addresses.evm }, sol: { address: e.addresses.sol } } : materialize(e, readSecret(e, key), idx);
    const rows = await Promise.all(keys.map(async k => {
      const address = k === 'sol' ? w.sol.address : w.evm.address;
      try { return { chain: k, symbol: symbolOf(k), address, balance: await nativeBalance(k, address) }; }
      catch (x) { return { chain: k, symbol: symbolOf(k), address, error: (x.shortMessage || x.message || String(x)).split('\n')[0].slice(0, 80) }; }
    }));
    if (opt.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) {
      console.log(`${r.chain.padEnd(8)} ${r.error ? 'error: ' + r.error : (Number(r.balance) === 0 ? '0' : r.balance) + ' ' + r.symbol}`);
    }
    return;
  }

  if (cmd === 'send') {
    const [k] = resolveChainKeys(opt.chain === 'all' ? err('--chain is required for send (one chain)') : opt.chain);
    if (resolveChainKeys(opt.chain).length !== 1) err('send takes exactly one --chain');
    if (!opt.to) err('--to required');
    if (!opt.amount) err('--amount required');
    const to = validateRecipient(k, opt.to);
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    if (!e.chains.includes(k === 'sol' ? 'sol' : 'evm')) err(`wallet has no ${k === 'sol' ? 'solana' : 'evm'} key`);
    const w = materialize(e, readSecret(e, key), Number(opt.index));
    const p = await previewSend(k, {
      from: k === 'sol' ? w.sol.address : w.evm.address, to, amount: opt.amount,
      privateKey: w.evm?.privateKey, secretKey: w.sol?.secretKey,
    });
    warn([
      `chain    ${k}`,
      `from     ${p.from}  (#${e.id} ${e.label}${Number(opt.index) ? ' index ' + opt.index : ''})`,
      `to       ${p.to}`,
      `amount   ${p.amount} ${p.symbol}`,
      `max fee  ${p.fee} ${p.symbol}${p.gas ? '  (gas ' + p.gas + ', nonce ' + p.nonce + ')' : ''}`,
      `balance  ${p.balance} -> ${p.after} ${p.symbol}`,
      ...p.warnings.map(x => `WARNING  ${x}`),
    ].join('\n'));
    if (p.warnings.some(x => x.startsWith('insufficient'))) err('aborted: insufficient balance');
    if (opt['dry-run']) { warn('dry-run: nothing sent'); return; }
    if (!opt.yes) {
      const a = await visiblePrompt(`Send ${p.amount} ${p.symbol} on ${k} to ${p.to}? type "send" to broadcast: `);
      if (a !== 'send') err('aborted');
    }
    const result = await p._exec();
    const hash = String(result).split(' ')[0];
    console.log(result);
    warn(explorerTx(k, hash));
    return;
  }

  if (cmd === 'import') {
    const label = args[0] ?? err('label required');
    if (!opt.mnemonic && !opt.evm && !opt.sol) err('choose --mnemonic, --evm or --sol (the secret is prompted, never passed on the command line)');
    if (process.argv.some(a => /^(0x)?[0-9a-fA-F]{64}$/.test(a) || a.split(/\s+/).length >= 12)) err('never pass secrets as arguments; they end up in shell history and ps. Use the prompt.');
    const { vault, key, created } = await open({ confirm: !existsVault() });
    if (created) warn(`created new vault at ${DEFAULT_VAULT_PATH}`);
    const raw = opt.mnemonic ? await hiddenPrompt('Paste mnemonic (hidden): ') : null;
    const evmPk = opt.evm ? await hiddenPrompt('Paste EVM private key (hidden): ') : null;
    const solKey = opt.sol ? await hiddenPrompt('Paste Solana secret key (hidden): ') : null;
    let addresses = {}, secret, chains;
    if (raw) {
      chains = chainsFromOpt();
      ({ addresses, secret } = walletFromMnemonic(raw, chains, 0));
    } else {
      secret = { kind: 'raw' }; chains = [];
      if (evmPk) { const w = evmFromPrivateKey(evmPk); addresses.evm = w.address; secret.evmPrivateKey = w.privateKey; chains.push('evm'); }
      if (solKey) { const w = solFromSecretKey(solKey); addresses.sol = w.address; secret.solSecretKey = w.secretKey; chains.push('sol'); }
      if (!chains.length) err('empty secret');
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
    // New passphrase is always prompted; WV_PASSPHRASE is deliberately ignored here.
    const next = await hiddenPrompt('New passphrase: ');
    if (next !== await hiddenPrompt('Confirm new passphrase: ')) err('passphrases do not match');
    if (!existsVaultChanged(vault, key, next)) err('new passphrase must differ from the current one');
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

function existsVault() { return existsSync(DEFAULT_VAULT_PATH); }
function existsVaultChanged(vault, key, candidate) {
  try { return !deriveKey(candidate, vault.kdf.salt, vault.kdf).equals(key); } catch { return true; }
}

main().catch(e => err(e.message));
