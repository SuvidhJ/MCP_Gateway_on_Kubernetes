// Entry point: Streamable HTTP MCP endpoint at /mcp, health at /healthz.
// Env: PORT (8080), WC_URL, WC_CK, WC_CS, STORE, STORE_CURRENCY, PUBLIC_STORE_URL, WC_TIMEOUT_MS.
import http from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildServer, configFromEnv } from './server.js';

const cfg = configFromEnv();
const port = Number(process.env.PORT ?? 8080);
const handler = toNodeHandler(createMcpHandler(() => buildServer(cfg), { keepAliveMs: 15_000 }));

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (path === '/mcp') return void handler(req, res);
  res.writeHead(404).end();
});
server.listen(port, () => console.error(`[woo-mcp ${cfg.store}] :${port} -> ${cfg.wcUrl}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
