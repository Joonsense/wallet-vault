// After a wallet is funded on a testnet: an over-limit MCP attempt (must be denied), then a real 0.001 send via MCP.
//   node scripts/live-send-check.mjs [wallet] [chain] [to]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [wallet = 'test1', chain = 'base-sepolia', to = '0x203709E514A69823ac445E202d126D00c3F3AFD6'] = process.argv.slice(2);
const t = new StdioClientTransport({ command: process.execPath, args: ['--no-deprecation', 'src/cli.mjs', 'mcp'], env: process.env, stderr: 'pipe' });
const c = new Client({ name: 'live', version: '0' });
await c.connect(t);
const over = await c.callTool({ name: 'send_native', arguments: { wallet, chain, to, amount: '0.02', dry_run: true } });
console.log('over-limit 0.02 ->', over.isError ? 'DENIED: ' + (JSON.parse(over.content[0].text).reasons || [over.content[0].text]).join('; ') : 'UNEXPECTEDLY ALLOWED');
const r = await c.callTool({ name: 'send_native', arguments: { wallet, chain, to, amount: '0.001', dry_run: false } });
if (r.isError) console.log('MCP send error:', r.content[0].text.slice(0, 400));
else { const j = JSON.parse(r.content[0].text); console.log('MCP sent:', j.result, '\n' + j.explorer, '\nspent_last_24h before this:', j.spent_last_24h); }
await c.close();
