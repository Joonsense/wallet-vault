# Security

wallet-vault holds real private keys. Read this before trusting it with anything you cannot afford to lose.

## What it protects against

| Threat | Mechanism |
| --- | --- |
| Vault file leaks | scrypt (N=2^17) key derivation, AES-256-GCM per entry, secret ciphertext bound to the entry id (AAD) |
| An agent (MCP client) overspending | Owner policy: chain allowlist, recipient allowlist, per-tx and rolling 24h limits, token limits as separate keys; denials are logged |
| An agent editing `vault.json` to loosen its own policy | Each policy is HMAC-signed with a subkey of the vault key, bound to the entry id, chains, addresses and ciphertext. Unsigned or altered policies hide the wallet from agents |
| An agent truncating, editing or deleting the spend ledger | HMAC chain over records, signed head file, signed epoch marker inside the vault. Any mismatch denies agent sends; recovery is an explicit `wv ledger reset` |
| Two sends racing the daily limit | Policy re-check and the pending reservation happen inside one cross-process lock |
| A send that may or may not have been broadcast | Signed locally first (hash known), reserved as `pending`, errors after broadcast become `unknown` and keep counting until `wv reconcile` settles them on chain |
| Native drain through token sends | Solana token-account rent paid to third parties is evaluated against the native policy and logged separately |
| Secrets in shell history or `ps` | Imports read secrets from a hidden prompt only; argv secrets are rejected |

## What it does not protect against

- A process running as the same OS user with shell access. It can read the keychain or `WV_PASSPHRASE_CMD` output just like `wv` does. The policy layer bounds an agent that talks to the MCP tool interface; it does not bound an agent you have given a shell.
- A coordinated rollback of `vault.json`, `ledger.jsonl` and `ledger.jsonl.head` to an earlier consistent state. Keep backups and watch `wv history` if that matters to you.
- Malware on the machine, a compromised Node.js dependency, or a malicious RPC endpoint returning false balances. Pin RPCs you trust with `WV_RPC_<CHAIN>`.
- Loss of the passphrase. There is no recovery. Export mnemonics (`wv export <id> --mnemonic`) and store them offline.

## Reporting

Open a GitHub issue for anything that is not an exploitable weakness. For an exploitable weakness, email the maintainer listed in `package.json` before publishing details.
