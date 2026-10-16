// Manual MCP smoke test: spawns `wv mcp` and calls the tools. Usage: WV_VAULT=.. WV_PASSPHRASE=.. node scripts/mcp-smoke.mjs <wallet> <to>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const [wallet, to] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-deprecation', 'src/cli.mjs', 'mcp'], env: process.env, stderr: 'pipe' });
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const tools = (await client.listTools()).tools.map(t => t.name);
console.log('tools:', tools.join(', '));
const show = (label, r) => console.log(`\n== ${label} ${r.isError ? '[isError]' : ''}\n${r.content[0].text.slice(0, 700)}`);
show('list_wallets', await client.callTool({ name: 'list_wallets', arguments: {} }));
show('get_policy', await client.callTool({ name: 'get_policy', arguments: { wallet } }));
show('get_balance sol-devnet', await client.callTool({ name: 'get_balance', arguments: { wallet, chain: 'sol-devnet,base-sepolia' } }));
show('send denied (chain)', await client.callTool({ name: 'send_native', arguments: { wallet, chain: 'base', to: '0x000000000000000000000000000000000000dEaD', amount: '0.001', dry_run: true } }));
show('send denied (allowlist)', await client.callTool({ name: 'send_native', arguments: { wallet, chain: 'sol-devnet', to: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', amount: '0.001', dry_run: true } }));
show('send dry_run allowed', await client.callTool({ name: 'send_native', arguments: { wallet, chain: 'sol-devnet', to, amount: '0.001', dry_run: true } }));
show('send to non-agent wallet', await client.callTool({ name: 'send_native', arguments: { wallet: 'cold', chain: 'sol-devnet', to, amount: '0.001', dry_run: true } }));
show('spend_history', await client.callTool({ name: 'spend_history', arguments: { wallet, limit: 5 } }));
await client.close();
