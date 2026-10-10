// Tiny MCP client for checks: node scripts/mcp-call.mjs <url> <tool|--list> [json-args] [bearer]
// Run from the repo root so @modelcontextprotocol/client resolves from the workspace.
// Exit codes: 0 ok, 3 rejected (401/403), 4 connection/other error, 5 tool returned isError.
// Env: MODE=legacy|auto (default auto: modern era when the server supports it).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const [url, tool, args = '{}', bearer] = process.argv.slice(2);
const c = new Client({ name: 'mcp-call', version: '0' }, { versionNegotiation: { mode: process.env.MODE ?? 'auto' } });
const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
try {
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  if (tool === '--list') {
    const { tools } = await c.listTools(undefined, { cacheMode: 'bypass' });
    console.log(tools.map((t) => t.name).join('\n'));
  } else {
    const r = await c.callTool({ name: tool, arguments: JSON.parse(args) });
    console.log(r.isError ? 'isError' : 'ok', r.content?.[0]?.text?.slice(0, Number(process.env.MAX ?? 600)));
    process.exit(r.isError ? 5 : 0);
  }
} catch (e) {
  const status = e?.status ?? e?.cause?.status;
  console.log('error', status ?? '', String(e?.message ?? e).slice(0, 300));
  process.exit(status === 401 || status === 403 || /\b40[13]\b|Unauthorized/.test(String(e?.message)) ? 3 : 4);
}
process.exit(0);
