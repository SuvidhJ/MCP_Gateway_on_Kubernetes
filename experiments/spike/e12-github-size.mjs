import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const out = {};
for (const mode of ['auto', 'legacy']) {
  const c = new Client({ name: 'e12', version: '0' }, { versionNegotiation: { mode } });
  await c.connect(new StreamableHTTPClientTransport(new URL('https://api.githubcopilot.com/mcp/readonly'), { requestInit: { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` } } }));
  const { tools } = await c.listTools(); out[mode] = tools; await c.close();
}
const t = (m) => out[m].find(x => x.name === 'get_file_contents');
for (const m of ['auto', 'legacy']) {
  const x = t(m); console.log(m, 'keys:', Object.keys(x).join(','), '| sizes:', Object.fromEntries(Object.entries(x).map(([k, v]) => [k, JSON.stringify(v).length])));
  const sum = {}; for (const tool of out[m]) for (const [k, v] of Object.entries(tool)) sum[k] = (sum[k] ?? 0) + JSON.stringify(v).length; console.log('   totals by key:', sum);
}
console.log('auto inputSchema sample:', JSON.stringify(t('auto').inputSchema).slice(0, 400));
