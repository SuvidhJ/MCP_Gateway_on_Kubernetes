// Downstream client test: connect to the spike gateway in a given era and exercise routing/errors.
// Usage: node spike/client-test.mjs <legacy|auto> [key] [url]
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const mode = process.argv[2] ?? 'auto';
const key = process.argv[3] ?? 'k1';
const url = process.argv[4] ?? 'http://127.0.0.1:7801/mcp';

const client = new Client({ name: `client-test-${mode}`, version: '0.0.1' }, { versionNegotiation: { mode } });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
const t0 = Date.now();
await client.connect(transport);
console.log(JSON.stringify({ mode, negotiated: client.getNegotiatedProtocolVersion(), discover: !!client.getDiscoverResult(), session: transport.sessionId ?? null, ms: Date.now() - t0 }));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map(t => t.name).join(', '));

const calls = [
  ['demo__echo', { text: 'hi' }],
  ['shipping__search', { query: 'rates' }],
  ['demo__search', { query: 'rates' }],
  ['demo__fail', {}],
  ['nope__missing', {}],
  ['deepwiki__read_wiki_structure', { repoName: 'modelcontextprotocol/typescript-sdk' }],
  ['mslearn__microsoft_docs_search', { query: 'AKS network policy' }],
  ['cfdocs__search_cloudflare_documentation', { query: 'Workers KV limits' }],
  ['demo__slow', { seconds: 12 }],
];
for (const [name, args] of calls) {
  if (!tools.find(t => t.name === name) && name !== 'nope__missing') { console.log(`- ${name}: (not listed, skipped)`); continue; }
  const s = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args }, { timeout: 30_000 });
    const text = (r.content ?? []).map(c => c.text ?? `[${c.type}]`).join(' ').replace(/\s+/g, ' ');
    console.log(`- ${name}: ${r.isError ? 'isError' : 'ok'} ${Date.now() - s}ms :: ${text.slice(0, 140)}`);
  } catch (e) {
    console.log(`- ${name}: THROW ${e.constructor.name} ${e.code ?? ''} ${String(e.message).slice(0, 160)} (${Date.now() - s}ms)`);
  }
}
await client.close();
