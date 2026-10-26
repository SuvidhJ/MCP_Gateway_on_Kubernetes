// Entry point: Streamable HTTP MCP endpoint at /mcp, health at /healthz.
// Env: PORT (8080), WC_URL, WC_CK, WC_CS, STORE, STORE_CURRENCY, PUBLIC_STORE_URL, WC_TIMEOUT_MS,
//      MCP_TOKEN (bearer token the gateway must send; defence in depth next to the NetworkPolicy).
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildServer, configFromEnv } from './server.js';
import { authorized } from './logic.js';

const cfg = configFromEnv();
const port = Number(process.env.PORT ?? 8080);
const token = process.env.MCP_TOKEN ?? '';
if (!token && process.env.NODE_ENV === 'production') throw new Error('MCP_TOKEN is required');
const handler = toNodeHandler(createMcpHandler(() => buildServer(cfg), { keepAliveMs: 15_000 }));

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path === '/mcp') {
    if (!authorized(req.headers.authorization, token)) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="woo-mcp"' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: only the Urumi gateway may call this server' }, id: null }));
      return;
    }
    return void handler(req, res);
  }
  res.writeHead(404).end();
});
server.listen(port, () => console.error(`[woo-mcp ${cfg.store}] :${port} -> ${cfg.wcUrl}${token ? ' (token required)' : ' (no token: dev only)'}`));
// Finish in-flight calls, but don't wait forever on open SSE streams.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 8000).unref();
});
