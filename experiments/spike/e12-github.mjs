// E12b: GitHub remote MCP (/readonly) through the SDK client: era, session, tool count, Mcp-Param requirement on a call.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const token = process.env.GH_TOKEN;
const url = 'https://api.githubcopilot.com/mcp/readonly';
for (const mode of ['auto', 'legacy']) {
  const c = new Client({ name: 'e12-github', version: '0' }, { versionNegotiation: { mode } });
  const t = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  try {
    await c.connect(t, { timeout: 15000 });
    const { tools } = await c.listTools();
    const withParam = tools.filter(x => JSON.stringify(x).includes('x-mcp-header'));
    const toks = Math.round(JSON.stringify(tools).length / 4);
    console.log(`[${mode}] negotiated=${c.getNegotiatedProtocolVersion()} session=${!!t.sessionId} tools=${tools.length} ~tokens=${toks} tools-with-x-mcp-header=${withParam.length} e.g. ${withParam.slice(0, 3).map(x => x.name).join(',')}`);
    try { const r = await c.callTool({ name: 'get_me', arguments: {} }); console.log(`[${mode}] get_me ->`, r.isError ? 'isError ' + r.content?.[0]?.text?.slice(0, 120) : 'ok login=' + (/"login":"([^"]+)"/.exec(r.content?.[0]?.text ?? '')?.[1])); }
    catch (e) { console.log(`[${mode}] get_me THREW`, e.constructor.name, e.code ?? '', String(e.message).slice(0, 200)); }
    const rp = tools.find(x => x.name === 'search_repositories');
    if (rp) { try { const r = await c.callTool({ name: 'search_repositories', arguments: { query: 'modelcontextprotocol typescript-sdk', perPage: 1 } }); console.log(`[${mode}] search_repositories ->`, r.isError ? 'isError ' + r.content?.[0]?.text?.slice(0, 160) : 'ok'); }
      catch (e) { console.log(`[${mode}] search_repositories THREW`, e.constructor.name, e.code ?? '', String(e.message).slice(0, 200)); } }
    await c.close();
  } catch (e) { console.log(`[${mode}] connect failed`, e.constructor.name, e.code ?? '', e.status ?? '', String(e.message).slice(0, 200)); }
}
