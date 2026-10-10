// E3: through Traefik — (1) modern listen stream idle for HOLD_S then a push; (2) a 90 s tools/call (modern, JSON response);
// (3) a 90 s tools/call on the legacy era (SSE response). Usage: node spike/e3-streams.mjs <baseUrl> <holdSeconds>
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const base = process.argv[2]; const HOLD = Number(process.argv[3] ?? 400);
const T0 = Date.now(); const rel = () => ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';
const mk = async (mode) => { const c = new Client({ name: `e3-${mode}`, version: '0' }, { versionNegotiation: { mode } });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer k1' } } })); return c; };
const modern = await mk('auto'); const legacy = await mk('legacy');
console.log(rel(), base, 'modern', modern.getNegotiatedProtocolVersion(), 'legacy', legacy.getNegotiatedProtocolVersion());
let pushes = 0;
modern.setNotificationHandler('notifications/tools/list_changed', async () => { pushes++; console.log(rel(), 'PUSH received over listen stream (#' + pushes + ')'); });
const sub = await modern.listen({ toolsListChanged: true });
console.log(rel(), 'listen acked, honored =', JSON.stringify(sub.honoredFilter));
sub.closed.then(r => console.log(rel(), 'LISTEN CLOSED reason =', r));
const slow = (c, label) => c.callTool({ name: 'demo__slow', arguments: { seconds: 90 } }, { timeout: 200_000 })
  .then(r => console.log(rel(), label, '90s call ->', r.isError ? 'isError' : 'ok', r.content?.[0]?.text))
  .catch(e => console.log(rel(), label, '90s call THREW', e.constructor.name, e.code ?? '', e.message));
await Promise.all([slow(modern, 'modern'), slow(legacy, 'legacy')]);
await new Promise(r => setTimeout(r, Math.max(0, HOLD * 1000 - (Date.now() - T0))));
console.log(rel(), 'triggering admin notify after', HOLD, 's idle');
await fetch(base + '/admin/notify');
await new Promise(r => setTimeout(r, 3000));
console.log(rel(), 'RESULT pushes =', pushes, 'subscription still open =', !(await Promise.race([sub.closed.then(() => true), new Promise(r => setTimeout(() => r(false), 10))])));
process.exit(0);
