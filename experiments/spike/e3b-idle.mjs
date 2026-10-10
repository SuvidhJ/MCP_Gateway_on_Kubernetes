// E3b: who cuts an idle (no keep-alive) listen stream at ~300 s? Usage: node spike/e3b-idle.mjs <baseUrl> <bodyTimeout:default|0> <holdS>
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Agent, fetch as uFetch } from 'undici';
const [base, bt, hold] = [process.argv[2], process.argv[3] ?? 'default', Number(process.argv[4] ?? 360)];
const f = bt === '0' ? ((u, i) => uFetch(u, { ...i, dispatcher: new Agent({ bodyTimeout: 0, headersTimeout: 0 }) })) : fetch;
const T0 = Date.now(); const rel = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
const c = new Client({ name: 'e3b', version: '0' }, { versionNegotiation: { mode: 'auto' } });
await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { fetch: f, requestInit: { headers: { Authorization: 'Bearer k1' } } }));
let pushes = 0; c.setNotificationHandler('notifications/tools/list_changed', async () => { pushes++; console.log(rel(), 'PUSH'); });
const sub = await c.listen({ toolsListChanged: true }); console.log(rel(), base, 'bodyTimeout=' + bt, 'listening');
let closed = null; sub.closed.then(r => { closed = r; console.log(rel(), 'CLOSED', r); });
await new Promise(r => setTimeout(r, hold * 1000));
await fetch(base + '/admin/notify').catch(() => {}); await new Promise(r => setTimeout(r, 2000));
console.log(rel(), 'RESULT pushes=' + pushes, 'closed=' + closed); process.exit(0);
