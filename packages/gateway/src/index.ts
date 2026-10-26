// Gateway entry point: one Hono app on one port serving
//   /mcp      the aggregated MCP endpoint (both protocol eras)
//   /api/*    the dashboard's REST API (docs/api.md) + /api/chat
//   /healthz  liveness/readiness
//   /*        the built dashboard SPA (packages/dashboard/dist)
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import * as z from 'zod';
import { config } from './config.js';
import { maintenance, migrate, one, pool, q, rateTake, waitForDb } from './db.js';
import { log } from './log.js';
import { ensureAdmin, sessionUser } from './auth.js';
import { UpstreamManager, type UpstreamRow } from './upstreams.js';
import { createGatewayMcp } from './mcp.js';
import { challenge, createOAuth, oauthApi, principalFromOAuth, revokeUserGrants } from './oauth.js';
import { provisioningApi } from './provisioning.js';
import { createApi } from './api.js';
import { chat } from './chat.js';
import { startEndpointWatch } from './k8s.js';
import { seal, unseal } from './sealed.js';
import { publish, subscribe } from './events.js';
import { startMetricsServer } from './metrics.js';

// A stray rejected promise must be visible in the logs, not silently kill the process mid-request.
process.on('unhandledRejection', (e) => log.error({ err: (e as Error)?.message ?? String(e) }, 'unhandled rejection'));

await waitForDb();
await migrate();
await ensureAdmin();
await seedServers();

const mgr = new UpstreamManager();
const mcp = createGatewayMcp(mgr, { challenge, principalFromOAuth });
// close a key's / OAuth grant's open streams here and on every other replica
const closeStreams = (ids: number[]) => {
  ids.forEach((id) => mcp.closeKeyStreams(id));
  if (ids.length) publish({ t: 'revoke', keyIds: ids });
};
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
startMetricsServer(mgr, config.metricsPort);
// Other replicas' admin changes and key revocations (several gateway replicas share one Postgres).
subscribe(async (ev) => {
  if (ev.t === 'upstream') await mgr.reloadUpstream(ev.id);
  else if (ev.t === 'access') await mgr.reloadAccess(ev.id, ev.tool);
  else if (ev.t === 'pin') await mgr.reloadPin(ev.id, ev.tool);
  else if (ev.t === 'revoke') ev.keyIds.forEach((id) => mcp.closeKeyStreams(id));
}, () => void mgr.load());

const app = new Hono();
// Behind TLS, a request that reached the ingress over plain HTTP goes to HTTPS before a password or key is read (HSTS
// only helps after a first HTTPS visit). Probes and in-cluster callers send no X-Forwarded-Proto; Traefik overwrites a
// client's. 308 keeps the method and body.
if (config.publicUrl.startsWith('https://')) {
  app.use('*', async (c, next) => {
    if (c.req.header('x-forwarded-proto') !== 'http') return next();
    const u = new URL(c.req.url);
    return c.redirect(`${config.publicUrl}${u.pathname}${u.search}`, 308);
  });
}
// liveness: the process answers. readiness: it can also reach Postgres (no auth, sessions or audit without it).
app.get('/healthz', (c) => c.json({ ok: true }));
app.get('/readyz', async (c) => {
  try {
    await Promise.race([pool.query('select 1'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: `postgres: ${(e as Error).message}` }, 503);
  }
});

// The body is refused unread: close the connection, or the proxy reuses it and its next request (someone else's) reads
// our leftover bytes and fails with a 502.
const tooLarge = (max: string) => (c: any) => c.json({ error: `request body too large (max ${max})` }, 413, { connection: 'close' });
app.use('/mcp', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: tooLarge('4 MB') }));
const chatLimit = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge('2 MB') });
const apiLimit = bodyLimit({ maxSize: 256 * 1024, onError: tooLarge('256 KB') });
// (one middleware per path: '/api/*' also matches /api/chat, and both limits would apply)
app.use('/api/*', (c, next) => (c.req.path === '/api/chat' ? chatLimit(c, next) : apiLimit(c, next)));
app.use('/oauth/*', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge('64 KB') }));
app.all('/mcp', (c) => mcp.fetch(c.req.raw));

const chatBody = z.object({ messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), parts: z.array(z.any()) }).passthrough()).min(1).max(200) }).passthrough();
app.post('/api/chat', async (c) => {
  if (!config.llmBaseUrl) return c.json({ error: 'chat is not configured (LLM_BASE_URL)' }, 503);
  const user = await sessionUser(getCookie(c, 'urumi_session'));
  if (!user) return c.json({ error: 'not logged in' }, 401);
  if (c.req.header('x-csrf-token') !== user.csrf) return c.json({ error: 'missing or wrong CSRF token' }, 403);
  if (user.mustChangePassword) return c.json({ error: 'change your temporary password first' }, 403);
  const parsed = chatBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: 'expected {"messages": [...]} (AI SDK UI messages)' }, 400);
  // every turn costs model tokens: a per-user budget, shared across replicas
  const wait = await rateTake(`chat:${user.id}`, config.chatPerMin, config.chatPerMin);
  if (wait) return c.json({ error: `chat rate limit (${config.chatPerMin} messages/minute); retry in ${wait}s` }, 429, { 'retry-after': String(wait) });
  // a client may not inject a system prompt: only ours is used
  const messages = parsed.data.messages.filter((m) => m.role !== 'system') as any[];
  return chat(user, messages, mgr, c.req.raw.signal);
});
app.route('/api', createApi(mgr, {
  closeKeyStreams: mcp.closeKeyStreams,
  revokeUserGrants,
  extend: (api) => { oauthApi(api, { closeStreams }); provisioningApi(api); },
}));
app.route('/', createOAuth({ closeStreams }));
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

// The dashboard: no framing (clickjacking on pages that show secrets once), no inline scripts, same-origin calls only.
app.use('/*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"], baseUri: ["'none'"], objectSrc: ["'none'"],
  },
  xFrameOptions: 'DENY',
  referrerPolicy: 'no-referrer',
  strictTransportSecurity: config.cookieSecure ? 'max-age=31536000' : false,
  crossOriginOpenerPolicy: config.cookieSecure ? 'same-origin' : false, // browsers ignore (and warn about) it on http
}));
const dist = path.resolve(config.dashboardDir);
if (fs.existsSync(path.join(dist, 'index.html'))) {
  const indexHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
  // SPA fallback for page routes only: an unknown /.well-known/... or /oauth/... path must be a real 404, or OAuth
  // clients would parse HTML as metadata
  app.get('*', (c) => (/^\/(\.well-known|oauth)\//.test(c.req.path) ? c.json({ error: 'not found' }, 404) : c.html(indexHtml)));
} else {
  app.get('/', (c) => c.text('dashboard not built (packages/dashboard/dist missing)'));
}
app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((e, c) => {
  log.error({ err: e.message, path: c.req.path }, 'request failed');
  return c.json({ error: 'internal error' }, 500);
});

// housekeeping every 10 minutes (one replica at a time, under an advisory lock)
const housekeeping = () => maintenance(config.auditRetentionDays, config.eventRetentionDays)
  .catch((e) => log.warn({ err: (e as Error).message }, 'maintenance failed'));
setTimeout(housekeeping, 30_000).unref();
setInterval(housekeeping, 10 * 60_000).unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, publicUrl: config.publicUrl, upstreams: mgr.ups.size }, 'gateway listening'));
// SSE listen streams and long tool calls must not be cut by Node's server timeouts.
(server as any).requestTimeout = 0;
(server as any).headersTimeout = 60_000;

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    // The pod's preStop sleep already let the Service drop this endpoint; finish in-flight requests, then exit.
    log.info({ sig }, 'shutting down');
    mgr.stop();
    mcp.close().catch(() => {}); // ends open listen streams so close() can finish
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

/** First start only: register the servers listed in SEED_SERVERS (the chart seeds woo-mcp, demo-upstream, DeepWiki).
 *  A seed may take its credential from an env var (`credentialEnv`, e.g. woo-mcp's token from a Secret); that one is
 *  kept in sync on every start while the server still points at its seeded URL, so a rotated Secret (or an upgrade
 *  that introduces the token) reaches the gateway without manual steps. */
async function seedServers() {
  if (!config.seedServers) return;
  type Seed = { slug: string; name: string; url: string; authHeader?: string; credential?: string; credentialEnv?: string; timeoutMs?: number };
  const list = JSON.parse(config.seedServers) as Seed[];
  // the credential is the full header value: a token from an env var is sent as a bearer token
  const credOf = (s: Seed) => {
    if (!s.credentialEnv) return s.credential;
    const v = process.env[s.credentialEnv];
    return v ? `Bearer ${v}` : undefined;
  };
  const done = await one(`select 1 from schema_migrations where version = -1`);
  if (!done) {
    for (const s of list) {
      const cred = credOf(s);
      await q<UpstreamRow>(`insert into upstreams(slug, name, url, auth_header, credential, timeout_ms) values ($1,$2,$3,$4,$5,$6) on conflict (slug) do nothing`,
        [s.slug, s.name, s.url, cred ? (s.authHeader ?? 'Authorization') : null, seal(cred), s.timeoutMs ?? null]);
    }
    await q(`insert into schema_migrations(version) values (-1) on conflict do nothing`); // marker: seeding done once
    log.info({ count: list.length }, 'seeded upstream servers');
  }
  for (const s of list.filter((x) => x.credentialEnv)) {
    const cred = credOf(s);
    if (!cred) continue;
    const row = await one<{ credential: string | null }>('select credential from upstreams where slug = $1 and url = $2', [s.slug, s.url]);
    if (!row) continue; // removed or re-pointed by an admin: theirs now
    let current: string | null = null;
    try { current = unseal(row.credential); } catch { /* undecryptable: replace */ }
    if (current !== cred) {
      await q('update upstreams set credential = $2, auth_header = $3 where slug = $1', [s.slug, seal(cred), s.authHeader ?? 'Authorization']);
      log.info({ slug: s.slug }, 'seeded server credential synced from its Secret');
    }
  }
}
