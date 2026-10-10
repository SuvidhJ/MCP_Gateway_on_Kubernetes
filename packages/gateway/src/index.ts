// Gateway entry point: one Hono app on one port serving
//   /mcp      the aggregated MCP endpoint (both protocol eras)
//   /api/*    the dashboard's REST API (docs/api.md) + /api/chat
//   /healthz  liveness/readiness
//   /*        the built dashboard SPA (packages/dashboard/dist)
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.js';
import { migrate, one, pool, q, waitForDb } from './db.js';
import { log } from './log.js';
import { ensureAdmin, sessionUser } from './auth.js';
import { UpstreamManager, type UpstreamRow } from './upstreams.js';
import { createGatewayMcp } from './mcp.js';
import { createApi } from './api.js';
import { chat } from './chat.js';
import { startEndpointWatch } from './k8s.js';

await waitForDb();
await migrate();
await ensureAdmin();
await seedServers();

const mgr = new UpstreamManager();
const mcp = createGatewayMcp(mgr);
// Coalesce bursts of changes (several upstreams flipping at once) into one list_changed push.
let pending: NodeJS.Timeout | undefined;
mgr.onToolsChanged = () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    try { mcp.notify(); } catch (e) { log.warn({ err: (e as Error).message }, 'notify failed'); }
  }, 100);
};
await mgr.load();
startEndpointWatch(mgr, config.k8sNamespace);

const app = new Hono();
app.get('/healthz', (c) => c.json({ ok: true }));
app.all('/mcp', (c) => mcp.fetch(c.req.raw));
app.post('/api/chat', async (c) => {
  if (!config.llmBaseUrl) return c.json({ error: 'chat is not configured (LLM_BASE_URL)' }, 503);
  const user = await sessionUser(getCookie(c, 'urumi_session'));
  if (!user) return c.json({ error: 'not logged in' }, 401);
  if (c.req.header('x-csrf-token') !== user.csrf) return c.json({ error: 'missing or wrong CSRF token' }, 403);
  const { messages } = await c.req.json();
  return chat(user, messages, mgr, c.req.raw.signal);
});
app.route('/api', createApi(mgr, { closeKeyStreams: mcp.closeKeyStreams }));
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

const dist = path.resolve(config.dashboardDir);
if (fs.existsSync(path.join(dist, 'index.html'))) {
  const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
  app.get('*', (c) => c.html(indexHtml)); // SPA fallback
} else {
  app.get('/', (c) => c.text('dashboard not built (packages/dashboard/dist missing)'));
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, publicUrl: config.publicUrl, upstreams: mgr.ups.size }, 'gateway listening'));
// SSE listen streams and long tool calls must not be cut by Node's server timeouts.
(server as any).requestTimeout = 0;
(server as any).headersTimeout = 60_000;

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    log.info({ sig }, 'shutting down');
    mgr.stop();
    await mcp.close().catch(() => {});
    server.close();
    await pool.end().catch(() => {});
    process.exit(0);
  });
}

/** First start only: register the servers listed in SEED_SERVERS (the chart seeds woo-mcp, demo-upstream, DeepWiki). */
async function seedServers() {
  if (!config.seedServers) return;
  const done = await one(`select 1 from schema_migrations where version = -1`);
  if (done) return;
  const list = JSON.parse(config.seedServers) as { slug: string; name: string; url: string; authHeader?: string; credential?: string; timeoutMs?: number }[];
  for (const s of list) {
    await q<UpstreamRow>(`insert into upstreams(slug, name, url, auth_header, credential, timeout_ms) values ($1,$2,$3,$4,$5,$6) on conflict (slug) do nothing`,
      [s.slug, s.name, s.url, s.credential ? (s.authHeader ?? 'Authorization') : null, s.credential ?? null, s.timeoutMs ?? null]);
  }
  await q(`insert into schema_migrations(version) values (-1) on conflict do nothing`); // marker: seeding done once
  log.info({ count: list.length }, 'seeded upstream servers');
}
