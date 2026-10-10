// E15: SSRF vectors (ToolHive#6197 + extras), redirect-to-metadata, DNS rebinding, SDK redirectPolicy.
import http from 'node:http';
import { fetch } from 'undici';
import { createGuardedAgent } from './ssrf-guard.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// A local "victim" service on 127.0.0.1:8099 that must never be reached, and an allow-listed "upstream" on
// 127.0.0.1:8098 (simulates an admin-registered public server) that redirects to internal targets.
const hits = [];
http.createServer((req, res) => { hits.push(req.url); res.end('VICTIM REACHED'); }).listen(8099, '127.0.0.1');
http.createServer((req, res) => {
  const to = new URL(req.url, 'http://x').searchParams.get('to');
  res.writeHead(302, { location: to }); res.end();
}).listen(8098, '127.0.0.1');
await new Promise(r => setTimeout(r, 300));

const agent = createGuardedAgent({ allowHosts: ['127.0.0.1.allowlisted.test'] });
// allow-list by name: map that name to 127.0.0.1:8098 via a tiny custom lookup is overkill; instead allow the literal
// redirect server by giving the trusted path its own agent:
const trustedForRedirectSrv = createGuardedAgent({ allowHosts: ['127.0.0.1'] });

const vectors = [
  'http://:8099/', 'http://localhost.:8099/', 'http://[fe80::1%25eth0]:8099/', 'http://2130706433:8099/', 'http://0177.0.0.1:8099/',
  'http://0x7f.1:8099/', 'http://127.1:8099/', 'http://127.000.000.001:8099/', 'http://0:8099/', 'http://0.0.0.0:8099/', 'http://[::]:8099/',
  'http://[::1]:8099/', 'http://[::ffff:127.0.0.1]:8099/', 'http://[0:0:0:0:0:ffff:7f00:1]:8099/', 'http://[::ffff:a9fe:a9fe]/',
  'http://[64:ff9b::7f00:1]:8099/', 'http://[2002:7f00:1::]:8099/', 'http://[fd00:ec2::254]/', 'http://169.254.169.254/latest/meta-data/',
  'http://localhost:8099/', 'http://localtest.me:8099/', 'http://127.0.0.1.nip.io:8099/', 'http://metadata.google.internal/',
  'https://example.com/',
];
const rows = [];
for (const v of vectors) {
  let parsed, out;
  try { parsed = new URL(v).host; } catch { rows.push([v, '(URL parse rejects)', 'n/a']); continue; }
  try { const r = await fetch(v, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(4000) }); out = `HTTP ${r.status}`; await r.body?.cancel(); }
  catch (e) { out = e.cause?.code || e.code || e.name; }
  rows.push([v, parsed, out]);
}
console.log('vector'.padEnd(42), 'WHATWG host'.padEnd(26), 'guarded result');
for (const [v, h, o] of rows) console.log(v.padEnd(42), String(h).padEnd(26), o);

console.log('\n-- redirect from an allowed upstream to internal targets (fetch redirect:follow, guarded per hop)');
for (const to of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8099/secret', 'http://[::ffff:127.0.0.1]:8099/x']) {
  // first hop allowed (127.0.0.1 allow-listed), second hop dialled through the strict agent via manual follow
  const first = await fetch(`http://127.0.0.1:8098/?to=${encodeURIComponent(to)}`, { dispatcher: trustedForRedirectSrv, redirect: 'manual' });
  const loc = first.headers.get('location');
  let out; try { const r = await fetch(loc, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(4000) }); out = `HTTP ${r.status}`; } catch (e) { out = e.cause?.code || e.code || e.name; }
  console.log(`302 -> ${to.padEnd(42)} second hop: ${out}`);
}

console.log('\n-- SDK client redirectPolicy (default same-origin) against a redirecting "MCP server"');
for (const to of ['http://169.254.169.254/mcp', 'http://127.0.0.1:8099/mcp']) {
  const c = new Client({ name: 'e15', version: '0' }, { versionNegotiation: { mode: 'auto' } });
  try { await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:8098/mcp?to=${encodeURIComponent(to)}`)), { timeout: 4000 }); console.log('connected?!'); }
  catch (e) { console.log(`redirect -> ${to.padEnd(30)} ${e.constructor.name} ${e.code ?? ''}: ${String(e.message).slice(0, 120)}`); }
}

console.log('\n-- DNS rebinding (rbndr.us alternates 93.184.215.14 <-> 127.0.0.1 per lookup); 8 attempts');
const rb = 'http://5db8d70e.7f000001.rbndr.us:8099/';
const tally = {};
for (let i = 0; i < 8; i++) {
  let out; try { const r = await fetch(rb, { dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(4000) }); out = `HTTP ${r.status}`; await r.body?.cancel(); }
  catch (e) { out = e.cause?.code || e.code || e.name; }
  tally[out] = (tally[out] ?? 0) + 1;
}
console.log(tally);
console.log('\nVICTIM HITS:', hits.length, hits);
process.exit(0);
