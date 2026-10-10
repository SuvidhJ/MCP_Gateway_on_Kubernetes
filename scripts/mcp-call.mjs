// Tiny MCP client for checks: node scripts/mcp-call.mjs <url> <tool|--list> [json-args] [bearer]
// Run from the repo root so @modelcontextprotocol/client resolves from the workspace.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const [url, tool, args = '{}', bearer] = process.argv.slice(2);
const c = new Client({ name: 'mcp-call', version: '0' }, { versionNegotiation: { mode: 'auto' } });
const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
if (tool === '--list') {
  const { tools } = await c.listTools();
  console.log(tools.map((t) => t.name).join('\n'));
} else {
  const r = await c.callTool({ name: tool, arguments: JSON.parse(args) });
  console.log(r.isError ? 'isError' : 'ok', r.content?.[0]?.text?.slice(0, 600));
}
process.exit(0);
