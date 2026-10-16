# wallet-vault (`wv`)

A local, self-custody wallet vault for humans **and** AI agents.

- Generate EVM + Solana wallets from one mnemonic in seconds, encrypted at rest on your machine.
- Send native coins and tokens (USDC and any ERC-20 / SPL) on 8 mainnets and 8 testnets.
- Give an agent a wallet it **cannot** overspend: per-transaction and rolling 24h limits, chain and recipient allowlists, enforced by a tamper-evident ledger.
- Expose those wallets to any MCP client (Claude Code, Cursor, your own agent) with `wv mcp`. No secret ever crosses the tool boundary.
- Manage Hyperliquid API (agent) wallets: fresh key, approve, list, rotate.

No cloud, no custodian, no telemetry. One JSON file, one passphrase, your keychain.

[한국어 README](./README.ko.md) · [Security model](./SECURITY.md)

## Install

Requires Node.js 20.11+.

```bash
# from npm (once published)
npm i -g wallet-vault

# or straight from GitHub
npm i -g github:Joonsense/wallet-vault

# or from a clone
git clone https://github.com/Joonsense/wallet-vault && cd wallet-vault
pnpm install && npm link        # puts `wv` on your PATH
```

## Quick start

```bash
wv new trader1                       # 24-word mnemonic -> EVM + Solana addresses, encrypted into the vault
wv list                              # addresses only, never secrets
wv balance trader1                   # native balance on all mainnets (--chain base,sol | testnets | --token USDC)
wv send trader1 --chain base --to 0x... --amount 0.01 --dry-run
wv send trader1 --chain base --to 0x... --amount 0.01          # type "send" to broadcast
wv send trader1 --chain sol --to <addr> --amount 5 --token USDC
eval "$(wv env trader1)"             # EVM_PRIVATE_KEY / SOL_SECRET_KEY into the current shell, for bots
wv export trader1 --mnemonic         # offline backup, after typing "reveal"
```

The vault lives at `~/.wallet-vault/vault.json` (`WV_VAULT` to move it). The passphrase comes from a hidden prompt, `WV_PASSPHRASE`, or `WV_PASSPHRASE_CMD` (a command whose stdout is the passphrase, e.g. a macOS Keychain lookup).

## Chains

| Key | Chain | Native | Testnet key |
| --- | --- | --- | --- |
| eth | Ethereum | ETH | sepolia |
| base | Base | ETH | base-sepolia |
| arb | Arbitrum One | ETH | arb-sepolia |
| op | OP Mainnet | ETH | op-sepolia |
| bnb | BNB Chain | BNB | bnb-testnet |
| polygon | Polygon PoS | POL | amoy |
| avax | Avalanche C-Chain | AVAX | fuji |
| sol | Solana | SOL | sol-devnet |

Public RPCs by default; set `WV_RPC_<CHAIN>` (dash as underscore, e.g. `WV_RPC_BASE_SEPOLIA`) for your own. `--chain all` means mainnets, `testnets` means testnets. All EVM chains share one key; Solana uses the same mnemonic on its own derivation path (MetaMask and Phantom compatible, verified against public test vectors).

USDC addresses come from Circle's official list; any other ERC-20 contract or SPL mint can be passed to `--token` directly. `wv faucet <wallet> --chain sol-devnet` requests a devnet airdrop; for EVM testnets it prints the address and faucet URLs.

## Spend policy

A policy turns a wallet into something you can hand to a bot.

```bash
wv policy set bot --chain base,sol --per-tx 0.01 --per-day 0.05 --agent on --note "swan hot wallet"
wv policy set bot --chain "*" --per-tx 0.001 --per-day 0.003          # default for other chains (native only)
wv policy set bot --chain base --token USDC --per-tx 5 --per-day 20   # token limits are separate keys
wv policy allow bot 0xMyColdWallet 9RqexsMySolanaCold                  # recipient allowlist (empty = anyone)
wv policy show bot
wv history bot                                                         # sent / pending / unknown / failed / denied
```

| Rule | Behaviour |
| --- | --- |
| Chain | sends on chains outside `chains` are denied |
| Recipient | if `allow` is non-empty, anything else is denied |
| Per tx | `perTx` per chain, or `*` for natives; tokens need `chain:TOKEN` or `*:TOKEN`, the native wildcard never applies |
| Per day | rolling 24h sum of sent + pending + unknown from the ledger, per chain and per token |
| No policy | a human on the CLI may proceed after confirming; an agent is denied |
| Override | only on the CLI, with `--override-policy` and typing `override`; the ledger marks the row `OVERRIDE` |

Sends are signed locally first, reserved in the ledger as `pending` inside a cross-process lock, then broadcast. Errors after broadcast become `unknown` and keep counting until `wv reconcile` checks the chain. On Solana, the rent of a recipient's new token account is treated as a native spend and checked against the native limit.

Policies and the ledger are HMAC-signed with a subkey of the vault key. If an agent edits `vault.json` or the ledger, the wallet disappears from the MCP server and agent sends are denied until the owner repairs it (`wv policy clear` + `set`, `wv ledger reset`). See [SECURITY.md](./SECURITY.md) for exactly what this does and does not defend against.

## MCP server

```bash
wv mcp     # stdio; needs WV_PASSPHRASE or WV_PASSPHRASE_CMD
```

Only wallets with `--agent on` are visible. Tools: `list_wallets`, `get_policy`, `get_balance`, `spend_history`, `send_native`, `send_token`. There is no tool that returns a key or mnemonic.

macOS setup with the Keychain, then Claude Code:

```bash
security add-generic-password -s wallet-vault -a "$USER" -w          # prompts for the passphrase once
claude mcp add --scope user wallet-vault \
  -e 'WV_PASSPHRASE_CMD=security find-generic-password -s wallet-vault -a '"$USER"' -w' \
  -- "$(command -v node)" "$(npm root -g)/wallet-vault/src/cli.mjs" mcp
```

Or in any MCP client config:

```json
{ "mcpServers": { "wallet-vault": {
  "command": "wv", "args": ["mcp"],
  "env": { "WV_PASSPHRASE_CMD": "security find-generic-password -s wallet-vault -a yourname -w" } } } }
```

## Hyperliquid agent wallets

Hyperliquid bots sign with an API wallet the main account has approved; the agent can trade but not withdraw.

```bash
wv hl agents main --testnet                 # approved agents, expiry, whether the key is in this vault
wv hl new-agent main --name swan --days 30  # fresh key -> vault -> approveAgent signed by main
wv hl approve main --agent 7 --name swan    # approve a key already in the vault
eval "$(wv env hl-swan)"                    # the bot gets the agent key; queries still use the main address
```

Rules follow the Hyperliquid docs: one unnamed plus up to three named agents per account, named agents expire (max 180 days via `--days`), re-approving a name replaces the previous agent, and a retired agent address is never reused.

## Storage and crypto

| Item | Value |
| --- | --- |
| Vault | `~/.wallet-vault/vault.json`, mode 600; ledger `ledger.jsonl` + `ledger.jsonl.head` next to it |
| KDF | scrypt N=2^17, r=8, p=1, 32-byte salt per vault |
| Cipher | AES-256-GCM per entry, entry id as AAD |
| Derivation | EVM `m/44'/60'/0'/0/i`, Solana `m/44'/501'/i'/0'` (SLIP-0010) |
| Integrity | HMAC-SHA256 subkeys for policy, ledger chain, ledger head and epoch marker |
| Libraries | viem, @scure/bip39, @noble/curves, @solana/web3.js, @solana/spl-token, @nktkas/hyperliquid, @modelcontextprotocol/sdk |

## Development

```bash
pnpm install
pnpm test              # offline: BIP-44 / SLIP-0010 vectors, vault crypto, policy, ledger integrity, lock races
pnpm run check         # syntax
WV_VAULT=/tmp/v.json WV_PASSPHRASE='dev dev dev dev' node scripts/mcp-smoke.mjs <wallet> <to>
```

## Status

v0.3, first public cut (October 2026). Not audited. Mainnet sends work the same way as testnet sends, but start with testnets and small amounts. Contributions and issues welcome.

MIT © Kai Kim
