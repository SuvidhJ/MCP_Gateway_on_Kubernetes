// E13 soak: N raw modern + legacy requests at concurrency C against the gateway; samples gateway heap after forced GC.
const N = Number(process.argv[2] ?? 20000), C = Number(process.argv[3] ?? 20);
const U = 'http://127.0.0.1:7801/mcp';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'soak', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
const mem = async () => (await fetch('http://127.0.0.1:7801/admin/mem')).json();
const bodies = [
  () => ({ h: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'demo__echo' }, b: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'demo__echo', arguments: { text: 'x' }, _meta: meta } } }),
  () => ({ h: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, b: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } } }),
  () => ({ h: { 'mcp-protocol-version': '2025-11-25' }, b: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'demo__echo', arguments: { text: 'y' } } } }),
];
let done = 0, errors = 0; const lat = [];
console.log('start', await mem());
const t0 = Date.now();
async function worker() {
  while (done < N) {
    const i = done++; const { h, b } = bodies[i % 3]();
    const s = performance.now();
    try {
      const r = await fetch(U, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer k1', ...h }, body: JSON.stringify(b) });
      const text = await r.text(); if (!r.ok || text.includes('"error"')) errors++;
    } catch { errors++; }
    lat.push(performance.now() - s);
    if (i > 0 && i % 5000 === 0) console.log(i, await mem());
  }
}
await Promise.all(Array.from({ length: C }, worker));
const secs = (Date.now() - t0) / 1000; lat.sort((a, b) => a - b);
const q = (p) => lat[Math.floor(lat.length * p)].toFixed(1);
console.log(JSON.stringify({ requests: N, concurrency: C, errors, secs, rps: Math.round(N / secs), p50ms: q(0.5), p95ms: q(0.95), p99ms: q(0.99) }));
await new Promise(r => setTimeout(r, 2000));
console.log('end', await mem());
