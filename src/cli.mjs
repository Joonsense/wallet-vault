#!/usr/bin/env -S node --no-deprecation
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { DEFAULT_VAULT_PATH, deriveKey, verifyPolicy, openVault, saveVaultFile, findEntry, addEntry, readSecret, removeEntry, rotatePassphrase, backupVaultFile } from './vault.mjs';
import { CHAINS, generateMnemonic, walletFromMnemonic, evmFromPrivateKey, solFromSecretKey, evmFromMnemonic, solFromMnemonic } from './wallets.mjs';
import { getPassphrase, hiddenPrompt, visiblePrompt } from './prompt.mjs';
import { prepareSend, executeSend, reconcile, applyPolicyFlags } from './ops.mjs';
import { describePolicy } from './policy.mjs';
import { history, verifyLedger, LEDGER_PATH } from './ledger.mjs';
import { listAgents, accountValue, agentNameFor, approveAgent, fmtValidUntil, HL_MAX_DAYS } from './hl.mjs';
import { resolveChainKeys, nativeBalance, previewSend, validateRecipient, symbolOf, explorerTx, txStatus, ALL_KEYS, MAINNET_KEYS, TESTNET_KEYS, isSol, isTestnet, solAirdrop, EVM_FAUCETS } from './chains.mjs';

const HELP = `wv - local encrypted wallet vault (EVM + Solana)

  wv new [label] [--chain evm|sol|all] [--words 12|24] [--count N] [--note "..."]
  wv list [--json]
  wv show <id|label|address> [--index N]
  wv export <id|label> (--mnemonic | --evm | --sol) [--index N] [--yes]
  wv env <id|label> [--index N]            # eval "$(wv env trader1)" -> EVM_PRIVATE_KEY, SOL_SECRET_KEY
  wv balance <id|label> [--chain base,sol | all | testnets] [--index N] [--json]
  wv send <id|label> --chain base --to 0x... --amount 0.01 [--index N] [--dry-run] [--yes] [--override-policy]
  wv history [<id|label>] [--limit 20]                       # local spend ledger (${'~/.wallet-vault/ledger.jsonl'})
  wv reconcile [<id|label>]                                  # settle pending/unknown ledger rows from chain state
  wv ledger verify                                           # HMAC chain + head check (policy and ledger are signed with the vault key)

  Spend policy (bounds every send; agents via MCP cannot exceed it, CLI needs --override-policy + "override"):
  wv policy show <id|label>
  wv policy set <id|label> --chain base,sol --per-tx 0.01 --per-day 0.05 [--agent on|off] [--note ..]   # --chain "*" = default limit
  wv policy allow <id|label> <addr> [<addr>..]   |   wv policy deny <id|label> <addr>   |   wv policy clear <id|label>
  wv mcp                                                      # MCP server on stdio (needs WV_PASSPHRASE or WV_PASSPHRASE_CMD)
  wv faucet <id|label> --chain sol-devnet [--amount 1]      # devnet airdrop; EVM testnets print faucet URLs

  Hyperliquid API wallets (agent keys that trade for a main account but cannot withdraw):
  wv hl agents <main> [--testnet]                           # approved agents + expiry, marks ones held in this vault
  wv hl new-agent <main> [--name bot1] [--days 30] [--testnet] [--dry-run] [--yes]
                                                            # fresh EVM key -> vault -> approveAgent signed by <main>
  wv hl approve <main> --agent <id|label> [--name ..] [--days N] [--testnet] [--yes]
                                                            # approve a wallet already in the vault (never reuse a retired agent)
  wv import <label> (--mnemonic | --evm | --sol) [--chain ...]   # secret is asked via hidden prompt, never argv
  wv rename <id|label> <new-label>
  wv rm <id|label> [--yes]
  wv passwd                                # rotate vault passphrase
  wv backup <dest-file>
  wv path                                  # vault location

  Mainnets: ${MAINNET_KEYS.join(' ')}
  Testnets: ${TESTNET_KEYS.join(' ')}
  RPC override: WV_RPC_<CHAIN> with - as _ (e.g. WV_RPC_BASE_SEPOLIA, WV_RPC_SOL_DEVNET)
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
    testnet: { type: 'boolean' },
    name: { type: 'string' },
    days: { type: 'string' },
    agent: { type: 'string' },
    'per-tx': { type: 'string' },
    'per-day': { type: 'string' },
    'override-policy': { type: 'boolean' },
    limit: { type: 'string' },
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

  if (cmd === 'balance') {
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    const idx = Number(opt.index);
    const keys = resolveChainKeys(opt.chain === 'all' ? null : opt.chain).filter(k => (isSol(k) ? e.chains.includes('sol') : e.chains.includes('evm')));
    if (!keys.length) err('this wallet has no key for the requested chains');
    // address only; no secret needed unless index > 0
    const w = idx === 0 ? { evm: { address: e.addresses.evm }, sol: { address: e.addresses.sol } } : materialize(e, readSecret(e, key), idx);
    const rows = await Promise.all(keys.map(async k => {
      const address = isSol(k) ? w.sol.address : w.evm.address;
      try { return { chain: k, symbol: symbolOf(k), address, balance: await nativeBalance(k, address) }; }
      catch (x) { return { chain: k, symbol: symbolOf(k), address, error: (x.shortMessage || x.message || String(x)).split('\n')[0].slice(0, 80) }; }
    }));
    if (opt.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) {
      console.log(`${r.chain.padEnd(12)} ${r.error ? 'error: ' + r.error : (Number(r.balance) === 0 ? '0' : r.balance) + ' ' + r.symbol}${isTestnet(r.chain) ? '  (testnet)' : ''}`);
    }
    return;
  }

  if (cmd === 'send') {
    const [k] = resolveChainKeys(opt.chain === 'all' ? err('--chain is required for send (one chain)') : opt.chain);
    if (resolveChainKeys(opt.chain).length !== 1) err('send takes exactly one --chain');
    if (!opt.to) err('--to required');
    if (!opt.amount) err('--amount required');
    const { vault, key } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    const idx = Number(opt.index);
    const prep = await prepareSend({ entry: e, key, chain: k, to: opt.to, amount: opt.amount, index: idx, via: 'cli' });
    const p = prep.preview;
    warn([
      `chain    ${k}${isTestnet(k) ? '  (testnet, no real value)' : '  (MAINNET, real funds)'}`,
      `from     ${p.from}  (#${e.id} ${e.label}${idx ? ' index ' + idx : ''})`,
      `to       ${p.to}`,
      `amount   ${p.amount} ${p.symbol}`,
      `max fee  ${p.fee} ${p.symbol}${p.gas ? '  (gas ' + p.gas + ', nonce ' + p.nonce + ')' : ''}`,
      `balance  ${p.balance} -> ${p.after} ${p.symbol}`,
      `policy   ${prep.policy.policy ? (prep.policy.ok ? 'ok' : 'DENIED') + (prep.policy.limit ? `  (per-tx ${prep.policy.limit.perTx ?? '-'}, per-day ${prep.policy.limit.perDay ?? '-'}, spent 24h ${prep.policy.spentToday})` : '') : 'none (CLI only)'}`,
      ...prep.policy.reasons.map(x => `POLICY   ${x}`),
      ...p.warnings.map(x => `WARNING  ${x}`),
    ].join('\n'));
    if (p.warnings.some(x => x.startsWith('insufficient'))) err('aborted: insufficient balance');
    if (opt['dry-run']) { warn('dry-run: nothing sent'); return; }
    let overridden = false;
    if (!prep.policy.ok) {
      if (!opt['override-policy']) err('aborted by policy (add --override-policy to bypass as the owner)');
      const a = await visiblePrompt(`Policy denies this send. Type "override" to bypass it as the owner: `);
      if (a !== 'override') err('aborted');
      overridden = true;
    }
    if (!opt.yes) {
      const a = await visiblePrompt(`Send ${p.amount} ${p.symbol} on ${k} to ${p.to}? type "send" to broadcast: `);
      if (a !== 'send') err('aborted');
    }
    const result = await executeSend({ entry: e, key, chain: k, via: 'cli', preview: p, overridden });
    const hash = String(result).split(' ')[0];
    console.log(result);
    warn(explorerTx(k, hash));
    return;
  }

  if (cmd === 'history') {
    const { vault } = await open();
    const e = args[0] ? findEntry(vault, args[0]) : null;
    const rows = history(e?.id ?? null, Number(opt.limit || 20));
    if (opt.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    if (!rows.length) { console.log(`(empty) ${LEDGER_PATH}`); return; }
    for (const r of rows) console.log(`${r.ts.slice(0, 19)}  #${r.wallet} ${String(r.label).padEnd(12)} ${r.chain.padEnd(12)} ${String(r.amount).padEnd(12)} ${r.status.padEnd(8)} ${r.via}${r.overridden ? ' OVERRIDE' : ''}  ${r.hash || r.error || (r.reasons || []).join('; ') || ''}`);
    return;
  }

  if (cmd === 'ledger') {
    const { key } = await open();
    const v = verifyLedger(key);
    console.log(v.ok ? `ok: ${v.count} records, head matches (${LEDGER_PATH})` : `FAIL: ${v.reason}`);
    if (!v.ok) process.exit(2);
    return;
  }

  if (cmd === 'reconcile') {
    const { vault, key } = await open();
    const e = args[0] ? findEntry(vault, args[0]) : null;
    const rows = await reconcile(history(e?.id ?? null, 500), { txStatus, key });
    if (!rows.length) { console.log('nothing pending or unknown'); return; }
    for (const r of rows) console.log(`${r.chain.padEnd(12)} ${r.hash}  ${r.before} -> ${r.after}  (chain: ${r.chainStatus})`);
    return;
  }

  if (cmd === 'policy') {
    const sub = args[0] ?? err('policy subcommand: show | set | allow | deny | clear');
    const { vault, key } = await open();
    const e = findEntry(vault, args[1] ?? err('wallet ref required'));
    if (sub === 'show') { console.log(`#${e.id} ${e.label}\n${describePolicy(e.policy)}${e.policy && !verifyPolicy(key, e) ? '\nWARNING  policy signature INVALID (edited outside wv); agents will not see this wallet until re-saved' : ''}`); return; }
    if (sub === 'set') {
      const chains = opt.chain === 'all' ? [] : opt.chain === '*' ? ['*'] : resolveChainKeys(opt.chain);
      const agent = opt.agent == null ? null : /^(on|true|yes|1)$/i.test(opt.agent) ? true : /^(off|false|no|0)$/i.test(opt.agent) ? false : err('--agent on|off');
      const num = (v, n) => v == null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : err(`${n} must be a number >= 0`));
      applyPolicyFlags(e, key, { chains, perTx: num(opt['per-tx'], '--per-tx'), perDay: num(opt['per-day'], '--per-day'), agent, note: opt.note });
    } else if (sub === 'allow' || sub === 'deny') {
      const addrs = args.slice(2);
      if (!addrs.length) err('address(es) required');
      for (const a of addrs) {
        const okEvm = /^0x[0-9a-fA-F]{40}$/.test(a);
        let okSol = false; try { validateRecipient('sol', a); okSol = true; } catch {}
        if (!okEvm && !okSol) err(`not an EVM or Solana address: ${a}`);
        if (okEvm) validateRecipient('eth', a);
      }
      applyPolicyFlags(e, key, sub === 'allow' ? { allowAdd: addrs } : { allowRemove: addrs });
    } else if (sub === 'clear') {
      applyPolicyFlags(e, key, { clear: true });
    } else err(`unknown policy subcommand "${sub}"`);
    saveVaultFile(vault);
    console.log(`#${e.id} ${e.label}\n${describePolicy(e.policy)}`);
    return;
  }

  if (cmd === 'mcp') {
    const { startMcp } = await import('./mcp.mjs');
    await startMcp();
    return new Promise(() => {});
  }

  if (cmd === 'faucet') {
    const [k] = resolveChainKeys(opt.chain === 'all' ? err('--chain required (sol-devnet or an EVM testnet)') : opt.chain);
    if (!isTestnet(k)) err(`${k} is a mainnet; faucets are for testnets only`);
    const { vault } = await open();
    const e = findEntry(vault, args[0] ?? err('wallet ref required'));
    if (isSol(k)) {
      if (!e.addresses.sol) err('wallet has no solana key');
      const amount = opt.amount ? Number(opt.amount) : 1;
      warn(`requesting ${amount} SOL airdrop on ${k} for ${e.addresses.sol} ...`);
      const sig = await solAirdrop(k, e.addresses.sol, amount);
      console.log(sig);
      warn(explorerTx(k, sig));
      return;
    }
    if (!e.addresses.evm) err('wallet has no evm key');
    console.log(`${k} has no RPC faucet. Paste this address into one of:\n  ${e.addresses.evm}\n` + EVM_FAUCETS[k].map(u => `  ${u}`).join('\n'));
    return;
  }

  if (cmd === 'hl') {
    const sub = args[0] ?? err('hl subcommand required: agents | new-agent | approve');
    const net = opt.testnet ? 'testnet' : 'MAINNET';
    const { vault, key } = await open();
    const main = findEntry(vault, args[1] ?? err('main wallet ref required'));
    if (!main.addresses.evm) err('main wallet has no EVM key');
    const inVault = (addr) => vault.entries.find(x => x.addresses.evm && x.addresses.evm.toLowerCase() === addr.toLowerCase());

    if (sub === 'agents') {
      const [agents, value] = await Promise.all([listAgents(main.addresses.evm, !!opt.testnet), accountValue(main.addresses.evm, !!opt.testnet).catch(() => null)]);
      warn(`${net}  main ${main.addresses.evm} (#${main.id} ${main.label})  account value ${value == null ? '?' : '$' + value.toFixed(2)}`);
      if (opt.json) { console.log(JSON.stringify(agents, null, 2)); return; }
      if (!agents.length) { console.log('(no approved agents)'); return; }
      for (const a of agents) {
        const held = inVault(a.address);
        console.log(`${(a.name || '(unnamed)').padEnd(18)} ${a.address}  ${fmtValidUntil(a.validUntil).padEnd(24)} ${held ? 'vault #' + held.id + ' ' + held.label : 'key NOT in vault'}`);
      }
      return;
    }

    if (sub === 'new-agent' || sub === 'approve') {
      const days = opt.days ? Number(opt.days) : 0;
      const hlName = agentNameFor(opt.name || '', days);
      let agent;
      if (sub === 'approve') {
        agent = findEntry(vault, opt.agent ?? err('--agent <id|label> required'));
        if (!agent.addresses.evm) err('agent wallet has no EVM key');
        if (agent.id === main.id) err('agent must be a different wallet from main');
        if (/retired|rotated/i.test(agent.note || '')) err('this agent was retired; HL docs warn against re-approving a used agent address. Use new-agent.');
      }
      const label = opt.name ? `hl-${opt.name}` : `hl-agent`;
      const plan = [
        `network   ${net}${opt.testnet ? '' : '  (real account)'}`,
        `main      ${main.addresses.evm}  (#${main.id} ${main.label})`,
        `agent     ${agent ? agent.addresses.evm + '  (#' + agent.id + ' ' + agent.label + ')' : '(fresh key, label ' + label + (vault.entries.some(x => x.label === label) ? '-' + (vault.nextId) : '') + ')'}`,
        `name      ${hlName || '(unnamed: replaces the current unnamed agent)'}`,
        `expiry    ${days ? days + ' days' : opt.name ? 'HL default for named agents' : 'HL default'}  (max ${HL_MAX_DAYS} days via --days)`,
        `effect    agent can trade for main, cannot withdraw. ${opt.name ? 'A same-named agent is deregistered.' : ''}`,
      ];
      warn(plan.join('\n'));
      if (opt['dry-run']) { warn('dry-run: nothing signed'); return; }
      if (!opt.yes) {
        const a = await visiblePrompt(`Sign approveAgent with main key on ${net}? type "approve": `);
        if (a !== 'approve') err('aborted');
      }
      const mainSecret = readSecret(main, key);
      if (!agent) {
        const mnemonic = generateMnemonic(24);
        const { addresses, secret } = walletFromMnemonic(mnemonic, ['evm'], 0);
        const finalLabel = vault.entries.some(x => x.label === label) ? `${label}-${vault.nextId}` : label;
        agent = addEntry(vault, key, { label: finalLabel, chains: ['evm'], addresses, secret, note: `HL agent of #${main.id} ${main.label} (${net}) pending approval` });
        saveVaultFile(vault);
        warn(`agent key saved as #${agent.id} ${agent.label} ${agent.addresses.evm}`);
      }
      try {
        const { response } = await approveAgent({ mainPrivateKey: mainSecret.evmPrivateKey, agentAddress: agent.addresses.evm, agentName: hlName, testnet: !!opt.testnet });
        agent.note = `HL agent of #${main.id} ${main.label} (${net}) name=${hlName || '(unnamed)'} approved ${new Date().toISOString().slice(0, 10)}`;
        saveVaultFile(vault);
        console.log(JSON.stringify(response));
        warn(`approved. bots use: eval "$(wv env ${agent.label})"  -> EVM_PRIVATE_KEY is the agent key, main address stays ${main.addresses.evm}`);
      } catch (x) {
        agent.note = `HL agent of #${main.id} ${main.label} (${net}) approval FAILED: ${(x.message || String(x)).slice(0, 80)}`;
        saveVaultFile(vault);
        err(`approveAgent rejected: ${x.message || x}\n(agent key kept as #${agent.id} ${agent.label}; fix the cause, then: wv hl approve ${main.label} --agent ${agent.id}${opt.name ? ' --name ' + opt.name : ''}${opt.testnet ? ' --testnet' : ''})`);
      }
      return;
    }
    err(`unknown hl subcommand "${sub}"`);
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
