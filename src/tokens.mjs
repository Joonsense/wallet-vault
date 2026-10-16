// ERC-20 (EVM) and SPL (Solana) token balances + transfers. Same two-phase shape as native sends in chains.mjs.
// USDC addresses: Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses (fetched 2026-10-16).
// BNB Chain USDC is Binance-Peg, not Circle-issued, so it is not listed; pass the contract address explicitly.
import { encodeFunctionData, formatUnits, parseUnits, getAddress, isAddress, keccak256 } from 'viem';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, getAccount, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { base58 } from '@scure/base';
import { EVM_CHAINS, evmPublic, evmWallet, solConnection, isSol, symbolOf } from './chains.mjs';

export const TOKENS = {
  USDC: {
    eth: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    arb: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', op: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', avax: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    sol: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    sepolia: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    'arb-sepolia': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', 'op-sepolia': '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
    amoy: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582', fuji: '0x5425890298aed601595a70AB815c96711a31Bc65',
    'sol-devnet': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
};

const ERC20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

/** 'USDC' -> registry address for the chain; a raw address/mint is accepted as is. Returns { address, symbolHint }. */
export function resolveToken(chain, spec) {
  const up = String(spec).toUpperCase();
  if (TOKENS[up]) {
    const addr = TOKENS[up][chain];
    if (!addr) throw new Error(`${up} has no known address on ${chain} (pass the contract/mint address explicitly)`);
    return { address: addr, symbolHint: up, known: true };
  }
  if (isSol(chain)) { try { new PublicKey(spec); } catch { throw new Error('token must be a known symbol or a base58 mint'); } return { address: spec, symbolHint: null, known: false }; }
  if (!isAddress(spec, { strict: false })) throw new Error('token must be a known symbol or an ERC-20 contract address');
  return { address: getAddress(spec), symbolHint: null, known: false };
}

/** Policy/ledger key for a token on a chain: 'USDC' for known tokens, else the address. */
export function tokenKey(chain, spec) { const t = resolveToken(chain, spec); return t.known ? t.symbolHint : t.address; }

async function erc20Meta(pub, address) {
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address, abi: ERC20, functionName: 'decimals' }),
    pub.readContract({ address, abi: ERC20, functionName: 'symbol' }).catch(() => '?'),
  ]);
  return { decimals: Number(decimals), symbol };
}

async function splMeta(conn, mintStr) {
  const mint = new PublicKey(mintStr);
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error('mint account not found on this cluster');
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(conn, mint, 'confirmed', programId);
  return { mint, programId, decimals: m.decimals };
}

/** Token balance as decimal string + meta. */
export async function tokenBalance(chain, owner, spec) {
  const t = resolveToken(chain, spec);
  if (isSol(chain)) {
    const conn = solConnection(chain);
    const { mint, programId, decimals } = await splMeta(conn, t.address);
    const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner), false, programId);
    let amount = 0n; try { amount = (await getAccount(conn, ata, 'confirmed', programId)).amount; } catch {}
    return { balance: formatUnits(amount, decimals), decimals, symbol: t.symbolHint || 'SPL', token: t.address };
  }
  const pub = evmPublic(chain);
  const { decimals, symbol } = await erc20Meta(pub, t.address);
  const raw = await pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [getAddress(owner)] });
  return { balance: formatUnits(raw, decimals), decimals, symbol: t.symbolHint || symbol, token: t.address };
}

/** Preview a token transfer. Same return shape as previewSend plus token fields; fee is in the native coin. */
export async function previewTokenSend(chain, { from, to, amount, spec, privateKey, secretKey }) {
  const t = resolveToken(chain, spec);
  if (isSol(chain)) {
    const conn = solConnection(chain);
    const kp = Keypair.fromSecretKey(base58.decode(secretKey));
    if (kp.publicKey.toBase58() !== from) throw new Error('secret key does not match the stored address');
    const { mint, programId, decimals } = await splMeta(conn, t.address);
    const units = parseUnits(String(amount), decimals);
    if (units <= 0n) throw new Error('amount must be > 0');
    const toKey = new PublicKey(to);
    const fromAta = getAssociatedTokenAddressSync(mint, kp.publicKey, false, programId);
    const toAta = getAssociatedTokenAddressSync(mint, toKey, true, programId);
    const [fromAcct, toInfo, lamports, { blockhash, lastValidBlockHeight }] = await Promise.all([
      getAccount(conn, fromAta, 'confirmed', programId).catch(() => null), conn.getAccountInfo(toAta), conn.getBalance(kp.publicKey), conn.getLatestBlockhash('confirmed'),
    ]);
    const have = fromAcct?.amount ?? 0n;
    const tx = new Transaction({ feePayer: kp.publicKey, blockhash, lastValidBlockHeight });
    let rent = 0;
    if (!toInfo) { tx.add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, toAta, toKey, mint, programId)); rent = await conn.getMinimumBalanceForRentExemption(165); }
    tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, kp.publicKey, units, decimals, [], programId));
    const fee = (await conn.getFeeForMessage(tx.compileMessage(), 'confirmed')).value ?? 5000;
    const warnings = [];
    if (!toInfo) warnings.push(`recipient has no token account; it will be created (rent ${rent / LAMPORTS_PER_SOL} SOL paid by sender)`);
    if (have < units) warnings.push(`insufficient balance: have ${formatUnits(have, decimals)} ${t.symbolHint || 'tokens'}, need ${formatUnits(units, decimals)}`);
    if (lamports < fee + rent) warnings.push(`insufficient balance: need ${(fee + rent) / LAMPORTS_PER_SOL} SOL for fee/rent, have ${lamports / LAMPORTS_PER_SOL}`);
    const sym = t.symbolHint || 'SPL';
    return {
      key: chain, from, to, amount: formatUnits(units, decimals), symbol: sym, token: t.address, tokenKey: t.known ? t.symbolHint : t.address,
      fee: (fee + rent) / LAMPORTS_PER_SOL, feeSymbol: 'SOL', balance: formatUnits(have, decimals), after: formatUnits(have - units, decimals), warnings,
      // Native value that leaves the wallet to a third party (rent for the recipient's new token account). Policy-checked as a native spend.
      nativeCost: rent ? rent / LAMPORTS_PER_SOL : 0,
      _prepare: async () => { tx.sign(kp); const sig = base58.encode(tx.signature); return { hash: sig, send: async () => { const s = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, 'confirmed'); return `${s} (confirmed)`; } }; },
    };
  }
  const pub = evmPublic(chain);
  const { account, client } = evmWallet(chain, privateKey);
  if (account.address.toLowerCase() !== from.toLowerCase()) throw new Error('private key does not match the stored address');
  const { decimals, symbol } = await erc20Meta(pub, t.address);
  const units = parseUnits(String(amount), decimals);
  if (units <= 0n) throw new Error('amount must be > 0');
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, units] });
  const [have, native, fees, nonce] = await Promise.all([
    pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [account.address] }),
    pub.getBalance({ address: account.address }), pub.estimateFeesPerGas(), pub.getTransactionCount({ address: account.address }),
  ]);
  let gas = 90_000n, gasErr = null;
  try { gas = (await pub.estimateGas({ account, to: t.address, data })) * 12n / 10n; } catch (e) { gasErr = e.shortMessage || e.message; }
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
  const feeWei = gas * maxFeePerGas;
  const warnings = [];
  if (gasErr) warnings.push(`gas estimate failed (${gasErr.split('\n')[0]}), using 90000`);
  if (have < units) warnings.push(`insufficient balance: have ${formatUnits(have, decimals)} ${symbol}, need ${formatUnits(units, decimals)}`);
  if (native < feeWei) warnings.push(`insufficient balance: need ${formatUnits(feeWei, 18)} ${symbolOf(chain)} for gas, have ${formatUnits(native, 18)}`);
  const code = await pub.getCode({ address: to }).catch(() => undefined);
  if (code && code !== '0x') warnings.push('recipient is a contract; make sure it can hold tokens');
  const sym = t.symbolHint || symbol;
  return {
    key: chain, from: account.address, to, amount: formatUnits(units, decimals), symbol: sym, token: t.address, tokenKey: t.known ? t.symbolHint : t.address,
    fee: formatUnits(feeWei, 18), feeSymbol: symbolOf(chain), balance: formatUnits(have, decimals), after: formatUnits(have - units, decimals), nonce, gas: gas.toString(), warnings,
    _prepare: async () => {
      const serialized = await client.signTransaction({ to: t.address, data, value: 0n, gas, ...fees, nonce, chain: EVM_CHAINS[chain] });
      const hash = keccak256(serialized);
      return { hash, send: async () => { const sent = await pub.sendRawTransaction({ serializedTransaction: serialized }); const r = await pub.waitForTransactionReceipt({ hash: sent, timeout: 120_000 }).catch(() => null); return r ? `${sent} (${r.status})` : `${sent} (sent, receipt not yet seen)`; } };
    },
  };
}
