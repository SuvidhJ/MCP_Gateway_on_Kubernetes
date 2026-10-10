// E12c: GitHub legacy-era call of a tool whose inputSchema declares x-mcp-header params (Mcp-Param requirement, TS#2639).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
for (const mode of ['legacy', 'auto']) {
  const c = new Client({ name: 'e12c', version: '0' }, { versionNegotiation: { mode } });
  await c.connect(new StreamableHTTPClientTransport(new URL('https://api.githubcopilot.com/mcp/readonly'), { requestInit: { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` } } }));
  const { tools } = await c.listTools();
  const t = tools.find(x => x.name === 'get_file_contents');
  const hdrParams = Object.entries(t.inputSchema.properties ?? {}).filter(([, v]) => v['x-mcp-header']).map(([k, v]) => `${k}->${v['x-mcp-header']}`);
  const sr = tools.find(x => x.name === 'search_repositories');
  const srHdr = Object.entries(sr.inputSchema.properties ?? {}).filter(([, v]) => v['x-mcp-header']).map(([k]) => k);
  console.log(`[${mode}] get_file_contents x-mcp-header params: ${hdrParams.join(', ') || 'none'} | search_repositories: ${srHdr.join(',') || 'none'}`);
  try {
    const r = await c.callTool({ name: 'get_file_contents', arguments: { owner: 'modelcontextprotocol', repo: 'typescript-sdk', path: 'README.md' } });
    console.log(`[${mode}] get_file_contents ->`, r.isError ? 'isError ' + JSON.stringify(r.content).slice(0, 200) : 'ok (' + JSON.stringify(r.content).length + ' chars)');
  } catch (e) { console.log(`[${mode}] get_file_contents THREW`, e.constructor.name, e.code ?? '', String(e.message).slice(0, 220)); }
  await c.close();
}
