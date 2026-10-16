// MCP server (stdio). Exposes ONLY agent-enabled wallets (policy.agent = true) and never any secret.
// Passphrase: WV_PASSPHRASE or WV_PASSPHRASE_CMD (e.g. macOS Keychain lookup). No TTY prompting here.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openVault, loadVaultFile, verifyPolicy, DEFAULT_VAULT_PATH } from './vault.mjs';
import { getPassphrase } from './prompt.mjs';
import { nativeBalance, resolveChainKeys, symbolOf, explorerTx, ALL_KEYS, isSol } from './chains.mjs';
import { prepareSend, executeSend, openVaultFull } from './ops.mjs';
import { describePolicy } from './policy.mjs';
import { history } from './ledger.mjs';

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = (s) => ({ ...text(s), isError: true });

export async function startMcp() {
  if (!process.env.WV_PASSPHRASE && !process.env.WV_PASSPHRASE_CMD) {
    throw new Error('MCP mode needs WV_PASSPHRASE or WV_PASSPHRASE_CMD (no interactive prompt on stdio)');
  }
  const pass = await getPassphrase();
  let { vault, key } = await openVaultFull(pass, DEFAULT_VAULT_PATH);
  let salt = vault.kdf.salt;

  // Re-read the vault file on every call so CLI policy edits apply live; re-derive the key only if the salt changed.
  const fresh = () => {
    const v = loadVaultFile(DEFAULT_VAULT_PATH);
    if (!v) throw new Error('vault file disappeared');
    if (v.kdf.salt !== salt) { ({ vault, key } = openVault(pass, DEFAULT_VAULT_PATH)); salt = vault.kdf.salt; }
    else if (!v.ledgerMeta) throw new Error('vault ledger metadata missing (fail closed)');
    else vault = v;
    return vault;
  };
  const agentWallets = () => fresh().entries.filter(e => {
    if (!e.policy?.agent) return false;
    if (!verifyPolicy(key, e)) { process.stderr.write(`wallet-vault: policy MAC invalid on #${e.id} ${e.label}; hidden from agents\n`); return false; }
    return true;
  });
  const pick = (ref) => {
    const list = agentWallets();
    const e = list.find(x => String(x.id) === String(ref) || x.label === ref || Object.values(x.addresses).some(a => a?.toLowerCase() === String(ref).toLowerCase()));
    if (!e) throw new Error(`no agent-enabled wallet "${ref}" (available: ${list.map(x => x.label).join(', ') || 'none'})`);
    return e;
  };
  const pub = (e) => ({ id: e.id, label: e.label, addresses: e.addresses, chains: e.policy.chains, limits: e.policy.limits, allow: e.policy.allow, note: e.policy.note });

  const server = new McpServer({ name: 'wallet-vault', version: '0.2.0' }, {
    instructions: 'Self-custody wallet vault. Only agent-enabled wallets are visible. Sends are bounded by per-tx and daily limits, chain and recipient allowlists set by the owner on the CLI; a denied send cannot be overridden from here. Private keys and mnemonics are never exposed.',
  });

  server.registerTool('list_wallets', {
    description: 'Agent-enabled wallets: id, label, addresses (EVM + Solana), allowed chains, limits, recipient allowlist. No secrets.',
    inputSchema: {},
  }, async () => text(agentWallets().map(pub)));

  server.registerTool('get_policy', {
    description: 'Spend policy of one wallet, human readable.',
    inputSchema: { wallet: z.string().describe('wallet id, label or address') },
  }, async ({ wallet }) => { try { const e = pick(wallet); return text(describePolicy(e.policy)); } catch (x) { return fail(x.message); } });

  server.registerTool('get_balance', {
    description: `Balance of a wallet on one or more chains: native coin, or a token when "token" is given (USDC by symbol, or an ERC-20 address / SPL mint). Chains: ${ALL_KEYS.join(', ')} (or "all" for mainnets, "testnets").`,
    inputSchema: { wallet: z.string(), chain: z.string().default('all').describe('comma separated chain keys, "all" or "testnets"'), token: z.string().optional().describe('e.g. "USDC"; omit for the native coin') },
  }, async ({ wallet, chain, token }) => {
    try {
      const e = pick(wallet);
      const keys = resolveChainKeys(chain === 'all' ? null : chain).filter(k => (isSol(k) ? e.addresses.sol : e.addresses.evm));
      const rows = await Promise.all(keys.map(async k => {
        const address = isSol(k) ? e.addresses.sol : e.addresses.evm;
        try {
          if (token) { const { tokenBalance } = await import('./tokens.mjs'); const t = await tokenBalance(k, address, token); return { chain: k, symbol: t.symbol, token: t.token, address, balance: t.balance }; }
          return { chain: k, symbol: symbolOf(k), address, balance: await nativeBalance(k, address) };
        } catch (x) { return { chain: k, symbol: token || symbolOf(k), address, error: (x.shortMessage || x.message).split('\n')[0].slice(0, 100) }; }
      }));
      return text(rows);
    } catch (x) { return fail(x.message); }
  });

  server.registerTool('spend_history', {
    description: 'Recent send attempts of a wallet from the local ledger (sent, failed, denied, pending).',
    inputSchema: { wallet: z.string(), limit: z.number().int().min(1).max(200).default(20) },
  }, async ({ wallet, limit }) => { try { const e = pick(wallet); return text(history(e.id, limit)); } catch (x) { return fail(x.message); } });

  const sendHandler = (forcedToken) => async ({ wallet, chain, to, amount, dry_run, token }) => {
    try {
      const e = pick(wallet);
      const [k] = resolveChainKeys(chain);
      if (resolveChainKeys(chain).length !== 1) return fail('exactly one chain');
      const tok = forcedToken === undefined ? (token || null) : forcedToken;
      const prep = await prepareSend({ entry: e, key, vault, chain: k, to, amount, via: 'mcp', token: tok });
      if (!prep.policy.ok) return fail({ denied: true, reasons: prep.policy.reasons });
      const p = prep.preview;
      const summary = { chain: k, token: p.token || null, from: p.from, to: p.to, amount: p.amount, symbol: p.symbol, max_fee: p.fee, fee_symbol: p.feeSymbol || p.symbol, balance_before: p.balance, balance_after: p.after, warnings: p.warnings, spent_last_24h: prep.policy.spentToday, limit: prep.policy.limit };
      if (p.warnings.some(w => w.startsWith('insufficient'))) return fail({ ...summary, error: 'insufficient balance' });
      if (dry_run) return text({ dry_run: true, ...summary });
      const result = await executeSend({ entry: e, key, vault, chain: k, via: 'mcp', preview: p });
      const hash = String(result).split(' ')[0];
      return text({ ...summary, result, explorer: explorerTx(k, hash) });
    } catch (x) { return fail(x.shortMessage || x.message || String(x)); }
  };

  server.registerTool('send_native', {
    description: 'Send the native coin (ETH/BNB/POL/AVAX/SOL) from an agent-enabled wallet. Enforces the owner policy: chain allowlist, recipient allowlist, per-tx and 24h limits. Use dry_run=true first to see fee and balance effect. Returns tx hash and explorer link.',
    inputSchema: {
      wallet: z.string(), chain: z.string().describe('one chain key, e.g. base, arb, sol, base-sepolia, sol-devnet'),
      to: z.string().describe('recipient address'), amount: z.string().describe('decimal amount in native units, e.g. "0.01"'),
      dry_run: z.boolean().default(false),
    },
  }, sendHandler(null));

  server.registerTool('send_token', {
    description: 'Send an ERC-20 or SPL token (e.g. USDC) from an agent-enabled wallet. Token limits are separate policy keys (chain:TOKEN) the owner must set; the native wildcard never applies. Gas/fees are paid in the native coin. dry_run=true to preview.',
    inputSchema: {
      wallet: z.string(), chain: z.string().describe('one chain key'), token: z.string().describe('"USDC", or an ERC-20 contract address / SPL mint'),
      to: z.string(), amount: z.string().describe('decimal amount in token units, e.g. "5"'), dry_run: z.boolean().default(false),
    },
  }, sendHandler(undefined));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`wallet-vault MCP up. agent wallets: ${agentWallets().map(e => e.label).join(', ') || 'none (set one with: wv policy set <wallet> --agent on ...)'}\n`);
}
