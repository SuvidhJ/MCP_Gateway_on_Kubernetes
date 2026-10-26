// B1: upstream fetches must never follow a redirect (a registered server could bounce the gateway's POST, with its
// JSON-RPC body, to an allow-listed in-cluster host).
import http from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { baseFetch } from './upstreams.js';

let target = 0;
let hits = 0;
const servers: http.Server[] = [];
const listen = (h: http.RequestListener) => new Promise<number>((r) => {
  const s = http.createServer(h).listen(0, '127.0.0.1', () => r((s.address() as any).port));
  servers.push(s);
});
let evil = 0;
beforeAll(async () => {
  target = await listen((_q, res) => { hits++; res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); });
  evil = await listen((_q, res) => { res.writeHead(307, { location: `http://127.0.0.1:${target}/mcp` }).end(); });
});
afterAll(() => servers.forEach((s) => s.close()));

test('a 307 from an upstream is an error, and the redirect target is never contacted', async () => {
  await expect(baseFetch(`http://127.0.0.1:${evil}/mcp`, { method: 'POST', body: '{}' })).rejects.toThrow();
  expect(hits).toBe(0);
});
