// What does the SDK client throw for each failure class? (feeds the health/breaker classifier)
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const show = (label, e) => console.log(label.padEnd(34), '|', e?.constructor?.name, '| code=', e?.code, '| status=', e?.status, '| msg=', String(e?.message).slice(0, 90), '| cause=', e?.cause?.code ?? e?.cause?.name ?? '', String(e?.cause?.message ?? '').slice(0, 60));
async function tryConnect(label, url, opts = {}) {
  const c = new Client({ name: 'errshapes', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  try { await c.connect(new StreamableHTTPClientTransport(new URL(url), opts), { timeout: 4000 }); console.log(label.padEnd(34), '| connected?!'); return c; }
  catch (e) { show(label, e); }
}
await tryConnect('connect: refused port', 'http://127.0.0.1:7899/mcp');
await tryConnect('connect: NXDOMAIN', 'http://nonexistent.invalid/mcp');
await tryConnect('connect: blackhole (10.255.255.1)', 'http://10.255.255.1/mcp');
await tryConnect('connect: 401 (no token)', 'http://127.0.0.1:7803/mcp');
await tryConnect('connect: 404 path', 'http://127.0.0.1:7802/nope');
await tryConnect('connect: non-MCP 200 (example.com)', 'https://example.com/');
// call after upstream death: start a throwaway upstream, connect, kill it, call
import { spawn } from 'node:child_process';
const p = spawn(process.execPath, ['spike/upstream.mjs'], { env: { ...process.env, PORT: '7898', NAME: 'victim' }, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
const c = await tryConnect('connect victim', 'http://127.0.0.1:7898/mcp');
try { await c.callTool({ name: 'slow', arguments: { seconds: 2 } }, { timeout: 1000 }); } catch (e) { show('call: SDK timeout 1s', e); }
p.kill(); await new Promise(r => setTimeout(r, 500));
try { await c.callTool({ name: 'echo', arguments: { text: 'x' } }, { timeout: 4000 }); } catch (e) { show('call: after upstream killed', e); }
try { await c.listTools(undefined, { cacheMode: 'bypass', timeout: 4000 }); } catch (e) { show('listTools: after upstream killed', e); }
process.exit(0);
