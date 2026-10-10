import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const c = new Client({ name: 'one', version: '0' }, { versionNegotiation: { mode: 'auto' } });
await c.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7801/mcp'), { requestInit: { headers: { Authorization: 'Bearer k1' } } }));
const r = await c.callTool({ name: process.argv[2], arguments: JSON.parse(process.argv[3] ?? '{}') });
console.log(r.isError ? 'isError' : 'ok', JSON.stringify(r.content).slice(0, 200)); process.exit(0);
