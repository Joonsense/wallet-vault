// Chain table + RPC clients. Public RPCs by default; override per chain with WV_RPC_<KEY> (e.g. WV_RPC_BASE, WV_RPC_SOL).
import { createPublicClient, createWalletClient, http, formatEther, parseEther, getAddress, isAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, arbitrum, optimism, bsc, polygon, avalanche, sepolia, baseSepolia, arbitrumSepolia, optimismSepolia, bscTestnet, polygonAmoy, avalancheFuji } from 'viem/chains';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import { base58 } from '@scure/base';

export const EVM_CHAINS = {
  // mainnets
  eth: mainnet, base, arb: arbitrum, op: optimism, bnb: bsc, polygon, avax: avalanche,
  // testnets
  sepolia, 'base-sepolia': baseSepolia, 'arb-sepolia': arbitrumSepolia, 'op-sepolia': optimismSepolia,
  'bnb-testnet': bscTestnet, amoy: polygonAmoy, fuji: avalancheFuji,
};
export const SOL_CHAINS = {
  sol: { rpc: 'https://api.mainnet-beta.solana.com', cluster: null, testnet: false },
  'sol-devnet': { rpc: 'https://api.devnet.solana.com', cluster: 'devnet', testnet: true },
};
const ALIASES = {
  ethereum: 'eth', mainnet: 'eth', arbitrum: 'arb', optimism: 'op', bsc: 'bnb', matic: 'polygon', pol: 'polygon', avalanche: 'avax', solana: 'sol',
  'eth-sepolia': 'sepolia', 'polygon-amoy': 'amoy', 'avax-fuji': 'fuji', 'bsc-testnet': 'bnb-testnet', devnet: 'sol-devnet', 'solana-devnet': 'sol-devnet',
};
export const MAINNET_KEYS = ['eth', 'base', 'arb', 'op', 'bnb', 'polygon', 'avax', 'sol'];
export const TESTNET_KEYS = ['sepolia', 'base-sepolia', 'arb-sepolia', 'op-sepolia', 'bnb-testnet', 'amoy', 'fuji', 'sol-devnet'];
export const ALL_KEYS = [...MAINNET_KEYS, ...TESTNET_KEYS];
export const isSol = (key) => key in SOL_CHAINS;
export const isTestnet = (key) => TESTNET_KEYS.includes(key);

export function resolveChainKeys(spec) {
  if (!spec || spec === 'all' || spec === 'mainnets') return MAINNET_KEYS;
  if (spec === 'testnets') return TESTNET_KEYS;
  if (spec === 'everything') return ALL_KEYS;
  return String(spec).split(',').map(s => s.trim().toLowerCase()).map(s => ALIASES[s] || s).map(k => {
    if (!ALL_KEYS.includes(k)) throw new Error(`unknown chain "${k}" (${ALL_KEYS.join(', ')}, or all/testnets)`);
    return k;
  });
}

function rpcFor(key, fallback) {
  return process.env[`WV_RPC_${key.toUpperCase().replace(/-/g, '_')}`] || fallback;
}

export function evmPublic(key) {
  const chain = EVM_CHAINS[key];
  return createPublicClient({ chain, transport: http(rpcFor(key, chain.rpcUrls.default.http[0]), { timeout: 15_000 }) });
}

export function evmWallet(key, privateKey) {
  const chain = EVM_CHAINS[key];
  const account = privateKeyToAccount(privateKey);
  return { account, client: createWalletClient({ account, chain, transport: http(rpcFor(key, chain.rpcUrls.default.http[0]), { timeout: 30_000 }) }) };
}

export function solConnection(key = 'sol') {
  return new Connection(rpcFor(key, SOL_CHAINS[key].rpc), { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

export function symbolOf(key) {
  return isSol(key) ? 'SOL' : EVM_CHAINS[key].nativeCurrency.symbol;
}

export function explorerTx(key, hash) {
  if (isSol(key)) return `https://solscan.io/tx/${hash}${SOL_CHAINS[key].cluster ? '?cluster=' + SOL_CHAINS[key].cluster : ''}`;
  const base = EVM_CHAINS[key].blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : hash;
}

/** Native balance as a decimal string, or throws. */
export async function nativeBalance(key, address) {
  if (isSol(key)) {
    const lamports = await solConnection(key).getBalance(new PublicKey(address), 'confirmed');
    return (lamports / LAMPORTS_PER_SOL).toString();
  }
  const wei = await evmPublic(key).getBalance({ address });
  return formatEther(wei);
}

export function validateRecipient(key, to) {
  if (isSol(key)) {
    try { return new PublicKey(to).toBase58(); } catch { throw new Error('invalid Solana address'); }
  }
  if (!isAddress(to, { strict: false })) throw new Error('invalid EVM address');
  if (to !== to.toLowerCase() && to !== getAddress(to)) throw new Error('EVM address checksum mismatch (typo?)');
  return getAddress(to);
}

/** Build a preview of a native transfer without sending. */
export async function previewSend(key, { from, to, amount, privateKey, secretKey }) {
  if (isSol(key)) {
    const conn = solConnection(key);
    const kp = Keypair.fromSecretKey(base58.decode(secretKey));
    if (kp.publicKey.toBase58() !== from) throw new Error('secret key does not match the stored address');
    const lamports = Math.round(Number(amount) * LAMPORTS_PER_SOL);
    if (!(lamports > 0)) throw new Error('amount must be > 0');
    const toKey = new PublicKey(to);
    const [balance, toInfo, { blockhash, lastValidBlockHeight }] = await Promise.all([
      conn.getBalance(kp.publicKey), conn.getAccountInfo(toKey), conn.getLatestBlockhash('confirmed'),
    ]);
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight })
      .add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: toKey, lamports }));
    const fee = (await conn.getFeeForMessage(tx.compileMessage(), 'confirmed')).value ?? 5000;
    const rentMin = toInfo ? 0 : await conn.getMinimumBalanceForRentExemption(0);
    const warnings = [];
    if (!toInfo && lamports < rentMin) warnings.push(`recipient is a new account; needs at least ${rentMin / LAMPORTS_PER_SOL} SOL or the transfer fails`);
    if (balance < lamports + fee) warnings.push(`insufficient balance: have ${balance / LAMPORTS_PER_SOL} SOL, need ${(lamports + fee) / LAMPORTS_PER_SOL} SOL`);
    return {
      key, from, to, amount: lamports / LAMPORTS_PER_SOL, symbol: 'SOL',
      fee: fee / LAMPORTS_PER_SOL, balance: balance / LAMPORTS_PER_SOL, after: (balance - lamports - fee) / LAMPORTS_PER_SOL,
      warnings, _exec: async () => sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' }),
    };
  }
  const pub = evmPublic(key);
  const { account, client } = evmWallet(key, privateKey);
  if (account.address.toLowerCase() !== from.toLowerCase()) throw new Error('private key does not match the stored address');
  const value = parseEther(String(amount));
  if (value <= 0n) throw new Error('amount must be > 0');
  const [balance, fees, nonce] = await Promise.all([
    pub.getBalance({ address: account.address }), pub.estimateFeesPerGas(), pub.getTransactionCount({ address: account.address }),
  ]);
  let gas = 21000n, gasErr = null;
  try { gas = await pub.estimateGas({ account, to, value }); } catch (e) { gasErr = e.shortMessage || e.message; }
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  const feeWei = gas * maxFeePerGas;
  const warnings = [];
  if (gasErr) warnings.push(`gas estimate failed (${gasErr}), using 21000`);
  if (balance < value + feeWei) warnings.push(`insufficient balance: have ${formatEther(balance)}, need ${formatEther(value + feeWei)} (incl. max fee)`);
  const code = await pub.getCode({ address: to }).catch(() => undefined);
  if (code && code !== '0x') warnings.push('recipient is a contract; a plain native transfer may revert or be lost');
  return {
    key, from: account.address, to, amount: formatEther(value), symbol: symbolOf(key),
    fee: formatEther(feeWei), balance: formatEther(balance), after: formatEther(balance - value - feeWei), nonce, gas: gas.toString(), warnings,
    _exec: async () => {
      const hash = await client.sendTransaction({ to, value, gas, ...fees, nonce });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
      return receipt ? `${hash} (${receipt.status})` : `${hash} (sent, receipt not yet seen)`;
    },
  };
}

/** Solana devnet/testnet airdrop. Returns the confirmed signature. */
export async function solAirdrop(key, address, amountSol = 1) {
  if (!isSol(key) || !SOL_CHAINS[key].testnet) throw new Error('airdrop only on sol-devnet');
  const conn = solConnection(key);
  const sig = await conn.requestAirdrop(new PublicKey(address), Math.round(amountSol * LAMPORTS_PER_SOL));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

/** Where to get testnet gas for EVM testnets (web faucets, most need a login). */
export const EVM_FAUCETS = {
  sepolia: ['https://cloud.google.com/application/web3/faucet/ethereum/sepolia', 'https://www.alchemy.com/faucets/ethereum-sepolia'],
  'base-sepolia': ['https://portal.cdp.coinbase.com/products/faucet', 'https://www.alchemy.com/faucets/base-sepolia'],
  'arb-sepolia': ['https://www.alchemy.com/faucets/arbitrum-sepolia', 'https://faucet.quicknode.com/arbitrum/sepolia'],
  'op-sepolia': ['https://console.optimism.io/faucet', 'https://www.alchemy.com/faucets/optimism-sepolia'],
  'bnb-testnet': ['https://www.bnbchain.org/en/testnet-faucet'],
  amoy: ['https://faucet.polygon.technology/'],
  fuji: ['https://core.app/tools/testnet-faucet/'],
};
