// One-shot TESTNET funder, run by the owner. Reads a private key from the ENV VAR NAME given (never from argv),
// sends native testnet ETH, prints the tx. Stores nothing. Refuses mainnet chains.
//   node scripts/fund-from-env.mjs <ENV_VAR_NAME> <testnet-chain> <to> <amount>
import { createWalletClient, createPublicClient, http, parseEther, formatEther, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EVM_CHAINS, isTestnet } from '../src/chains.mjs';

const [envName, chainKey, to, amount] = process.argv.slice(2);
if (!envName || !chainKey || !to || !amount) { console.error('usage: fund-from-env.mjs <ENV_VAR_NAME> <testnet-chain> <to> <amount>'); process.exit(1); }
if (!isTestnet(chainKey) || !EVM_CHAINS[chainKey]) { console.error(`${chainKey} is not an EVM testnet; this script refuses mainnet`); process.exit(1); }
const raw = process.env[envName];
if (!raw) { console.error(`env var ${envName} is empty (export it in this shell first)`); process.exit(1); }
const acct = privateKeyToAccount(raw.startsWith('0x') ? raw : '0x' + raw);
const chain = EVM_CHAINS[chainKey];
const transport = http(process.env[`WV_RPC_${chainKey.toUpperCase().replace(/-/g, '_')}`] || chain.rpcUrls.default.http[0], { timeout: 30_000 });
const pub = createPublicClient({ chain, transport }), w = createWalletClient({ account: acct, chain, transport });
const before = await pub.getBalance({ address: acct.address });
console.error(`from ${acct.address} (${formatEther(before)} ${chain.nativeCurrency.symbol}) -> ${getAddress(to)} ${amount} on ${chainKey}`);
const hash = await w.sendTransaction({ to: getAddress(to), value: parseEther(amount) });
const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
console.log(`${hash} ${r.status}  ${chain.blockExplorers.default.url}/tx/${hash}`);
