// E17 watcher: polls gateway /admin/state every 200 ms and (optionally) calls demo__whoami every 500 ms,
// printing a timeline relative to T0 (the moment the kill command is issued by e17-killpod.sh).
// Usage: node spike/e17-watch.mjs <gatewayBase> <seconds> <calls:0|1>
import { spawn } from 'node:child_process';
const base = process.argv[2] ?? 'http://127.0.0.1:7901';
const secs = Number(process.argv[3] ?? 25);
const withCalls = process.argv[4] === '1';
const T0 = Date.now();
const rel = () => ((Date.now() - T0) / 1000).toFixed(2).padStart(6);
const out = (s) => console.log(`${rel()}s  ${s}`);

let last = {};
const poll = setInterval(async () => {
  try {
    const st = await (await fetch(`${base}/admin/state`)).json();
    for (const u of st) if (last[u.slug] !== u.status) { out(`gateway status ${u.slug}: ${last[u.slug] ?? '-'} -> ${u.status}${u.lastError ? ` (${u.lastError.slice(0, 60)})` : ''}`); last[u.slug] = u.status; }
  } catch (e) { out(`poll error ${e.message}`); }
}, 200);

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'e17', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
let lastCall = '';
const calls = withCalls && setInterval(async () => {
  const s = Date.now();
  try {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer k1', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'demo__whoami' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo__whoami', arguments: {}, _meta: meta } }) });
    const j = await r.json(); const txt = j.result?.content?.[0]?.text ?? JSON.stringify(j.error);
    const host = /"host":"([^"]+)"/.exec(txt)?.[1];
    const tag = j.result?.isError ? `isError: ${txt.slice(0, 70)}` : `ok host=${host}`;
    if (tag !== lastCall) { out(`call demo__whoami -> ${tag} (${Date.now() - s}ms)`); lastCall = tag; }
  } catch (e) { out(`call threw ${e.message}`); }
}, 500);

const w = spawn('kubectl', ['-n', 'exp', 'get', 'pods', '-l', 'app=demo-upstream', '-w', '--no-headers', '-o', 'custom-columns=NAME:.metadata.name,PHASE:.status.phase,READY:.status.containerStatuses[0].ready,DEL:.metadata.deletionTimestamp'], { shell: false });
w.stdout.on('data', d => d.toString().trim().split('\n').forEach(l => out(`pod  ${l.replace(/\s+/g, ' ')}`)));
const e = spawn('kubectl', ['-n', 'exp', 'get', 'endpointslices', '-l', 'kubernetes.io/service-name=demo-upstream', '-w', '--no-headers', '-o', 'custom-columns=READY:.endpoints[*].conditions.ready,ADDR:.endpoints[*].addresses[0]'], { shell: false });
e.stdout.on('data', d => d.toString().trim().split('\n').forEach(l => out(`eps  ${l.replace(/\s+/g, ' ')}`)));

setTimeout(() => { clearInterval(poll); calls && clearInterval(calls); w.kill(); e.kill(); process.exit(0); }, secs * 1000);
