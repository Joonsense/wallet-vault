// Hyperliquid API wallet (agent wallet) management.
// Main account key signs an EIP-712 approveAgent; the agent key then trades on its behalf but cannot withdraw.
// Rule from HL docs: never re-approve a previously used agent address (nonce set may be pruned -> replay). Always a fresh key.
import { HttpTransport, ExchangeClient, InfoClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';

export const HL_MAX_DAYS = 180;

export function hlTransport(testnet = false) {
  return new HttpTransport({ isTestnet: testnet, timeout: 20_000 });
}

/** Agents approved for a main account: [{ address, name, validUntil }] */
export async function listAgents(mainAddress, testnet = false) {
  const info = new InfoClient({ transport: hlTransport(testnet) });
  const agents = await info.extraAgents({ user: mainAddress });
  return agents.map(a => ({ address: getAddress(a.address), name: a.name, validUntil: a.validUntil }));
}

/** Account value on HL perps clearinghouse; 0 for an account HL does not know. */
export async function accountValue(mainAddress, testnet = false) {
  const info = new InfoClient({ transport: hlTransport(testnet) });
  const st = await info.clearinghouseState({ user: mainAddress });
  return Number(st?.marginSummary?.accountValue ?? 0);
}

/** Name HL will store: "<name>" or "<name> valid_until <ms>" when days is given. Unnamed agent = ''. */
export function agentNameFor(name, days) {
  if (!name) {
    if (days) throw new Error('unnamed agents cannot take --days (HL only supports valid_until on named agents)');
    return '';
  }
  if (name.length < 1 || name.length > 16) throw new Error('agent name must be 1..16 characters');
  if (/\s/.test(name)) throw new Error('agent name cannot contain spaces');
  if (!days) return name;
  if (!(days > 0 && days <= HL_MAX_DAYS)) throw new Error(`--days must be 1..${HL_MAX_DAYS}`);
  return `${name} valid_until ${Date.now() + Math.round(days * 86_400_000)}`;
}

/** Sign + submit approveAgent with the main account's private key. */
export async function approveAgent({ mainPrivateKey, agentAddress, agentName, testnet = false }) {
  const wallet = privateKeyToAccount(mainPrivateKey);
  const exchange = new ExchangeClient({ transport: hlTransport(testnet), wallet });
  const res = await exchange.approveAgent({ agentAddress: getAddress(agentAddress), agentName });
  return { main: wallet.address, response: res };
}

export function fmtValidUntil(ms) {
  if (ms == null) return 'no expiry';
  const d = new Date(ms);
  const days = Math.round((ms - Date.now()) / 86_400_000);
  return `${d.toISOString().slice(0, 10)} (${days >= 0 ? days + 'd left' : 'EXPIRED'})`;
}
