// OAuth on the gateway (MCP authorization spec 2026-07-28): the gateway is both the protected resource (/mcp) and its
// own authorization server, so a client can connect with only the gateway URL and a browser login instead of an API
// key. Implemented:
//   - Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource[/mcp], and a
//     `WWW-Authenticate: Bearer resource_metadata=…, scope="mcp"` challenge on every 401 from /mcp
//   - Authorization Server Metadata (RFC 8414) at /.well-known/oauth-authorization-server
//   - client registration: Client ID Metadata Documents (the client_id is an https URL we fetch, SSRF-guarded) and
//     Dynamic Client Registration (RFC 7591, kept for older clients); public clients only (no client secrets)
//   - authorization code + PKCE S256 (required), exact redirect URI match (any port for loopback, RFC 8252),
//     `resource` indicators (RFC 8707) with audience checks, `iss` in the response (RFC 9207), consent per client
//   - opaque access tokens (1 h) and rotating refresh tokens (30 d) with reuse detection; all stored as peppered HMACs
//   - revocation (RFC 7009) and from the dashboard ("Connected apps"); disabling a user revokes their grants
// Every OAuth grant acts as its user, exactly like an API key: same tool permissions, rate limit and audit (`via`
// = "oauth:<client name>").
import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { fetch as undiciFetch } from 'undici';
import { config } from './config.js';
import { extraMaintenance, one, q, rateTake } from './db.js';
import { log } from './log.js';
import { createSession, keyHash, passwordLogin, sessionUser, type Principal, type Rejected } from './auth.js';
import { createGuardedAgent } from './ssrf.js';

export const SCOPE = 'mcp';
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 120;
const COOKIE = 'urumi_session';

// ---- origins: the gateway may answer on several (prod https origin; locally also http://localhost:8080) ----
const ORIGINS = [config.publicUrl, ...config.extraOrigins].map((o) => new URL(o).origin);
const RESOURCES = new Set(ORIGINS.map((o) => `${o}/mcp`));
/** The configured origin this request came in on (by Host), else the public one. */
export function originOf(req: Request) {
  const host = (req.headers.get('host') ?? '').toLowerCase();
  return ORIGINS.find((o) => new URL(o).host === host) ?? ORIGINS[0];
}
const prmUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

/** The 401 challenge for /mcp: tells OAuth clients where to start (RFC 9728 §5.1, MCP scope guidance). */
export const challenge = (req: Request) => (error?: string, description?: string) =>
  `Bearer realm="urumi", resource_metadata="${prmUrl(originOf(req))}", scope="${SCOPE}"` +
  (error ? `, error="${error}"` : '') + (description ? `, error_description="${description.replace(/["\\]/g, "'")}"` : '');

// ---- storage (tables: migration 5 in db.ts) ----
extraMaintenance.push(
  `delete from oauth_codes where expires_at < now() - interval '1 hour'`,
  `delete from oauth_tokens where expires_at < now()`,
  // self-registered clients nobody ever authorized
  `delete from oauth_clients c where kind = 'dcr' and created_at < now() - interval '7 days' and not exists (select 1 from oauth_grants g where g.client_id = c.client_id)`,
);

const rand = (n: number) => crypto.randomBytes(n).toString('base64url');
const sign = (s: string) => crypto.createHmac('sha256', `oauth-req:${config.jwtSecret}`).update(s).digest('base64url');

// ---- redirect URIs ----
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** https, http on loopback, or an app's own scheme (RFC 8252 §7.1: com.example.app:/…, and in practice cursor://,
 *  vscode://); never a fragment, never a scheme a browser executes or a plain-http host. PKCE protects the code if
 *  another app claims the same scheme; the consent page says an app on the device will be opened. */
const BLOCKED_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'about', 'blob', 'filesystem', 'ftp', 'ws', 'wss', 'chrome', 'view-source', 'intent', 'jar', 'mailto', 'tel', 'sms']);
export function redirectAllowed(uri: string) {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash || uri.length > 2000) return false;
  if (u.protocol === 'https:') return !!u.hostname;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  const scheme = u.protocol.slice(0, -1);
  return /^[a-z][a-z0-9+.-]{1,62}$/.test(scheme) && !BLOCKED_SCHEMES.has(scheme);
}
/** Exact match, except that a loopback http redirect may use any port (RFC 8252 §7.3: native apps pick a free one). */
export function redirectMatches(registered: string[], uri: string) {
  if (registered.includes(uri)) return true;
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false;
  const strip = (x: URL) => `${x.protocol}//${x.hostname}${x.pathname}${x.search}`;
  return registered.some((r) => { try { const v = new URL(r); return v.protocol === 'http:' && LOOPBACK.has(v.hostname) && strip(v) === strip(u); } catch { return false; } });
}

// ---- clients ----
interface Client { client_id: string; kind: 'dcr' | 'cimd'; client_name: string; redirect_uris: string[]; client_uri: string | null }
const cimdAgent = createGuardedAgent({ allowHosts: [], timeout: 3000, externalTimeout: 5000, guard: config.ssrfGuard }); // no in-cluster allow-list
export const isCimdId = (id: string) => { try { const u = new URL(id); return u.protocol === 'https:' && u.pathname.length > 1 && !u.hash && !u.username; } catch { return false; } };

async function fetchCimd(id: string): Promise<Client> {
  const res = await undiciFetch(id, { dispatcher: cimdAgent, redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  if (res.status !== 200) throw new Error(`client metadata document answered HTTP ${res.status}`);
  const reader = res.body!.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 64 * 1024) { reader.cancel().catch(() => {}); throw new Error('client metadata document larger than 64 KB'); }
    chunks.push(value);
  }
  let doc: any;
  try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('client metadata document is not JSON'); }
  if (doc?.client_id !== id) throw new Error('client_id in the document does not match its URL');
  if (!Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0 || doc.redirect_uris.length > 20 || !doc.redirect_uris.every((r: unknown) => typeof r === 'string' && redirectAllowed(r)))
    throw new Error('redirect_uris missing or not allowed (https, http://localhost, or an app scheme)');
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) throw new Error('client_name missing');
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') throw new Error('only public clients (token_endpoint_auth_method "none") are supported');
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  const ttl = Math.min(Math.max(Number.isFinite(maxAge) ? maxAge : 3600, 300), 86400);
  const c: Client = { client_id: id, kind: 'cimd', client_name: String(doc.client_name).trim().slice(0, 100), redirect_uris: doc.redirect_uris, client_uri: typeof doc.client_uri === 'string' ? doc.client_uri.slice(0, 300) : null };
  await q(`insert into oauth_clients(client_id, kind, client_name, redirect_uris, client_uri, fetched_at, expires_at) values ($1,'cimd',$2,$3,$4,now(),now() + make_interval(secs => $5))
           on conflict (client_id) do update set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, client_uri = excluded.client_uri, fetched_at = now(), expires_at = excluded.expires_at`,
    [id, c.client_name, c.redirect_uris, c.client_uri, ttl]);
  return c;
}

async function getClient(id: string): Promise<Client | { error: string }> {
  if (!id || id.length > 2000) return { error: 'missing or invalid client_id' };
  const row = await one<Client & { expires_at: Date | null }>('select client_id, kind, client_name, redirect_uris, client_uri, expires_at from oauth_clients where client_id = $1', [id]);
  if (row && (row.kind === 'dcr' || (row.expires_at && row.expires_at > new Date()))) return row;
  if (!isCimdId(id)) return { error: 'unknown client_id (register first, or use a client metadata document URL)' };
  try {
    return await fetchCimd(id);
  } catch (e) {
    log.warn({ client_id: id, err: (e as Error).message }, 'client metadata document rejected');
    if (row) return row; // keep using a still-valid earlier copy if the refresh fails
    return { error: `client metadata document ${id}: ${(e as Error).message}` };
  }
}

// ---- tokens ----
async function issueTokens(grantId: number) {
  const access = `uat_${rand(32)}`;
  const refresh = `urt_${rand(32)}`;
  await q(`insert into oauth_tokens(hash, grant_id, kind, expires_at) values ($1,$3,'access',now() + make_interval(secs => $4)), ($2,$3,'refresh',now() + make_interval(secs => $5))`,
    [keyHash(access), keyHash(refresh), grantId, ACCESS_TTL_S, REFRESH_TTL_S]);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: SCOPE };
}
/** Revoked grants keep their (hashed) tokens until they expire, so a later call with one is still attributed to its
 *  user in the audit log ("access revoked") instead of being an anonymous unknown token. */
async function revokeGrant(id: number) {
  await q('update oauth_grants set revoked_at = coalesce(revoked_at, now()) where id = $1', [id]);
}

/** /mcp: resolve an access token to its user (or a refusal we can audit). */
export async function principalFromOAuth(token: string, req: Request): Promise<Principal | Rejected | undefined> {
  const r = await one(`select g.id::int as grant_id, g.client_name, g.resource, g.revoked_at, t.expires_at, u.id::int as id, u.email, u.role, u.disabled
      from oauth_tokens t join oauth_grants g on g.id = t.grant_id join users u on u.id = g.user_id
      where t.hash = $1 and t.kind = 'access'`, [keyHash(token)]);
  if (!r || new Date(r.expires_at) < new Date()) return undefined; // unknown or expired: the client refreshes
  const via = `oauth:${r.client_name}`;
  if (r.revoked_at) return { rejected: true, userId: r.id, email: r.email, via, reason: 'access revoked' };
  if (r.disabled) return { rejected: true, userId: r.id, email: r.email, via, reason: 'user disabled' };
  // audience (RFC 8707): only tokens issued for this gateway's MCP endpoint
  if (!RESOURCES.has(r.resource)) return { rejected: true, userId: r.id, email: r.email, via, reason: `token issued for ${r.resource}, not this server` };
  q(`update oauth_grants set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.grant_id]).catch(() => {});
  void req;
  // negative ids share the API keys' stream map, so a revocation closes this grant's open streams too
  return { userId: r.id, email: r.email, role: r.role, via, keyId: -r.grant_id, grantId: r.grant_id, bucket: `grant:${r.grant_id}` };
}

export async function revokeUserGrants(userId: number) {
  const rows = await q<{ id: number }>('update oauth_grants set revoked_at = now() where user_id = $1 and revoked_at is null returning id::int as id', [userId]);
  return rows.map((r) => -r.id);
}

// ---- HTML (login + consent): tiny server-rendered pages, no scripts ----
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
function page(c: Context, title: string, body: string, status: 200 | 400 | 401 | 403 | 429 = 200) {
  c.header('cache-control', 'no-store');
  c.header('x-frame-options', 'DENY'); // consent must not be clickjacked
  c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  c.header('referrer-policy', 'no-referrer');
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;background:#151b2c;color:#1c2333;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;padding:28px;width:min(440px,92vw);box-shadow:0 8px 30px #0005}h1{font-size:19px;margin:0 0 6px}
p{line-height:1.45}label{display:block;margin:12px 0 4px;font-size:13px;color:#555}input{width:100%;box-sizing:border-box;padding:9px;border:1px solid #ccd;border-radius:7px;font:inherit}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:10px;border-radius:7px;border:1px solid #ccd;background:#f4f5f8;font:inherit;cursor:pointer}
button.primary{background:#3b5bdb;border-color:#3b5bdb;color:#fff}.muted{color:#667;font-size:13px}.warn{background:#fff6e5;border:1px solid #f0c36d;padding:8px 10px;border-radius:7px;font-size:13px}
.err{background:#fdecec;border:1px solid #f2b8b5;padding:8px 10px;border-radius:7px;font-size:13px}code{background:#f1f2f6;padding:1px 5px;border-radius:4px;word-break:break-all}</style></head>
<body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`, status);
}
const errorPage = (c: Context, msg: string, status: 400 | 403 = 400) =>
  page(c, 'Cannot sign in this app', `<p class="err">${esc(msg)}</p><p class="muted">The app sent an invalid request, so you are not redirected back to it.</p>`, status);

/** Authorization request parameters, validated. Errors before the redirect URI is trusted render a page; later ones redirect. */
interface AuthzReq { client_id: string; redirect_uri: string; state?: string; code_challenge: string; resource: string; scope: string; origin: string }

function redirectWith(c: Context, a: { redirect_uri: string; state?: string; origin: string }, params: Record<string, string>) {
  const u = new URL(a.redirect_uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (a.state !== undefined) u.searchParams.set('state', a.state);
  u.searchParams.set('iss', a.origin); // RFC 9207
  c.header('cache-control', 'no-store');
  return c.redirect(u.toString(), 302);
}

async function validateAuthz(c: Context, p: Record<string, string | undefined>): Promise<{ ok: AuthzReq; client: Client } | Response> {
  const origin = originOf(c.req.raw);
  const client = await getClient(p.client_id ?? '');
  if ('error' in client) return errorPage(c, client.error);
  const redirect_uri = p.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : '');
  if (!redirect_uri || !redirectMatches(client.redirect_uris, redirect_uri)) return errorPage(c, `redirect_uri ${redirect_uri || '(missing)'} is not registered for ${client.client_name}`);
  const back = { redirect_uri, state: p.state, origin };
  if (p.response_type !== 'code') return redirectWith(c, back, { error: 'unsupported_response_type', error_description: 'only response_type=code' });
  if (!p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge))
    return redirectWith(c, back, { error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required' });
  const resource = canonicalResource(p.resource, origin);
  if (!resource) return redirectWith(c, back, { error: 'invalid_target', error_description: `resource must be ${origin}/mcp` });
  return { ok: { client_id: client.client_id, redirect_uri, state: p.state, code_challenge: p.code_challenge, resource, scope: SCOPE, origin }, client };
}
/** RFC 8707: the resource must name this gateway's MCP endpoint (its origin alone is accepted too). Absent = ours. */
function canonicalResource(resource: string | undefined, origin: string) {
  if (!resource) return `${origin}/mcp`;
  let u: URL;
  try { u = new URL(resource); } catch { return null; }
  if (u.hash) return null;
  const o = u.origin.toLowerCase();
  if (!ORIGINS.includes(o)) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return path === '/mcp' || path === '' ? `${o}/mcp` : null;
}

const packReq = (a: AuthzReq) => {
  const body = Buffer.from(JSON.stringify({ ...a, iat: Date.now() })).toString('base64url');
  return `${body}.${sign(body)}`;
};
function unpackReq(s: string | undefined): AuthzReq | null {
  const [body, mac] = (s ?? '').split('.');
  if (!body || !mac) return null;
  const want = sign(body);
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
  const a = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  return Date.now() - a.iat < 10 * 60_000 ? a : null; // the consent screen is valid for 10 minutes
}

function consentPage(c: Context, a: AuthzReq, client: Client, user: { email: string; csrf: string }) {
  const host = (() => { try { const u = new URL(a.redirect_uri); return u.protocol.startsWith('http') ? u.host : `${u.protocol}//`; } catch { return a.redirect_uri; } })();
  const local = (() => { try { return LOOPBACK.has(new URL(a.redirect_uri).hostname); } catch { return false; } })();
  const app = (() => { try { const p = new URL(a.redirect_uri).protocol; return p === 'http:' || p === 'https:' ? '' : `${p}//`; } catch { return ''; } })();
  const who = client.kind === 'cimd'
    ? `<p class="muted">Identified by its metadata at <code>${esc(client.client_id)}</code></p>`
    : `<p class="warn">This app registered itself; its name is not verified. Only continue if you just started a sign-in from it.</p>`;
  return page(c, `Allow ${client.client_name}?`, `
<p><strong>${esc(client.client_name)}</strong> wants to use the Urumi MCP gateway <strong>as you</strong> (${esc(user.email)}): call the tools you can call, recorded in the audit log under your name.</p>
${who}
<p class="muted">After you answer you are sent to <code>${esc(host)}</code>.</p>
${local ? '<p class="warn">That address is on your own computer (localhost): fine for desktop apps such as Claude Code; never approve a request you did not start.</p>' : ''}
${app ? `<p class="warn">This opens an app on your device (<code>${esc(app)}</code>). Only continue if you started the sign-in from that app.</p>` : ''}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="req" value="${esc(packReq(a))}"><input type="hidden" name="csrf" value="${esc(user.csrf)}">
<div class="row"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="allow">Allow</button></div></form>
<p class="muted">You can revoke this any time under Account → Connected apps in the dashboard.</p>`);
}

function loginPage(c: Context, next: string, message?: string, status: 200 | 401 | 429 = 200) {
  return page(c, 'Sign in to the Urumi gateway', `
<p class="muted">An app asked to connect to the MCP gateway as you. Sign in to review it.</p>
${message ? `<p class="err">${esc(message)}</p>` : ''}
<form method="post" action="/oauth/login"><input type="hidden" name="next" value="${esc(next)}">
<label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<div class="row"><button class="primary">Sign in</button></div></form>`, status);
}

// ---- routes ----
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version', 'access-control-max-age': '600' };
const clientAddr = (c: Context) => (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || 'direct';

export function createOAuth(hooks: { closeStreams: (ids: number[]) => void }) {
  const app = new Hono();
  // metadata, registration, token and revocation are called by browser-based clients too (no cookies: * is safe)
  for (const p of ['/.well-known/*', '/oauth/register', '/oauth/token', '/oauth/revoke']) app.options(p, (c) => c.body(null, 204, cors));

  const prm = (c: Context) => {
    const origin = originOf(c.req.raw);
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [SCOPE], bearer_methods_supported: ['header'],
      resource_name: 'Urumi MCP Gateway', resource_documentation: `${origin}/`,
    }, 200, cors);
  };
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/mcp', prm);
  app.get('/.well-known/oauth-authorization-server', (c) => {
    const o = originOf(c.req.raw);
    c.header('cache-control', 'public, max-age=300');
    return c.json({
      issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`, revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
      service_documentation: `${o}/`,
    }, 200, cors);
  });

  // Dynamic Client Registration (RFC 7591): public clients only, rate-limited, pruned when never used
  app.post('/oauth/register', async (c) => {
    const err = (e: string, d: string) => c.json({ error: e, error_description: d }, 400, cors);
    const wait = await rateTake(`dcr:${clientAddr(c)}`, 20, 2);
    if (wait) return c.json({ error: 'slow_down', error_description: `too many registrations; retry in ${wait}s` }, 429, { ...cors, 'retry-after': String(wait) });
    const b = await c.req.json().catch(() => null) as any;
    if (!b || typeof b !== 'object') return err('invalid_client_metadata', 'expected a JSON object');
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u: unknown) => typeof u === 'string' && redirectAllowed(u)))
      return err('invalid_redirect_uri', 'redirect_uris: 1-10 URIs, each https, http on localhost/127.0.0.1, or an app scheme (cursor://…, com.example.app:/…)');
    if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none') return err('invalid_client_metadata', 'only public clients: token_endpoint_auth_method "none"');
    const grants = b.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!Array.isArray(grants) || grants.some((g: unknown) => g !== 'authorization_code' && g !== 'refresh_token')) return err('invalid_client_metadata', 'grant_types: authorization_code, refresh_token');
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : 'Unnamed MCP client';
    const id = `dcr_${rand(18)}`;
    await q(`insert into oauth_clients(client_id, kind, client_name, redirect_uris, client_uri) values ($1,'dcr',$2,$3,$4)`,
      [id, name, uris, typeof b.client_uri === 'string' ? b.client_uri.slice(0, 300) : null]);
    return c.json({
      client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    }, 201, cors);
  });

  // Authorization endpoint: validate, then login (if needed) and consent
  app.get('/oauth/authorize', async (c) => {
    const v = await validateAuthz(c, c.req.query());
    if (v instanceof Response) return v;
    const user = await sessionUser(getCookie(c, COOKIE));
    if (!user) return loginPage(c, `/oauth/authorize?${new URL(c.req.url).searchParams.toString()}`);
    if (user.mustChangePassword) return page(c, 'Set your password first', `<p>You signed in with a temporary password. Open the <a href="/">dashboard</a>, choose your own password, then start the sign-in from the app again.</p>`, 403);
    return consentPage(c, v.ok, v.client, user);
  });

  app.post('/oauth/login', async (c) => {
    const f = await c.req.parseBody();
    const next = String(f.next ?? '');
    if (!next.startsWith('/oauth/authorize?')) return errorPage(c, 'invalid sign-in request'); // never an open redirect
    const r = await passwordLogin(String(f.email ?? ''), String(f.password ?? ''), clientAddr(c));
    if ('wait' in r) return loginPage(c, next, `Too many failed sign-ins; try again in ${r.wait}s.`, 429);
    if ('error' in r) return loginPage(c, next, 'Wrong email or password.', 401);
    const s = await createSession(r.user.id);
    setCookie(c, COOKIE, s.token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: config.cookieSecure, maxAge: config.sessionHours * 3600 });
    return c.redirect(next, 303);
  });

  app.post('/oauth/authorize', async (c) => {
    const f = await c.req.parseBody();
    const a = unpackReq(String(f.req ?? ''));
    if (!a) return errorPage(c, 'this consent screen expired or was altered; start the sign-in from the app again');
    const user = await sessionUser(getCookie(c, COOKIE));
    if (!user) return errorPage(c, 'your session ended; start the sign-in from the app again', 403);
    const csrf = String(f.csrf ?? '');
    if (csrf.length !== user.csrf.length || !crypto.timingSafeEqual(Buffer.from(csrf), Buffer.from(user.csrf))) return errorPage(c, 'invalid form token', 403);
    if (user.mustChangePassword) return errorPage(c, 'set your own password in the dashboard first', 403);
    // the client may have changed since the page was shown (CIMD refresh): validate again
    const client = await getClient(a.client_id);
    if ('error' in client || !redirectMatches(client.redirect_uris, a.redirect_uri)) return errorPage(c, 'this app is no longer registered with that redirect URI');
    if (f.decision !== 'allow') return redirectWith(c, a, { error: 'access_denied', error_description: 'the user denied access' });
    const code = rand(32);
    await q(`insert into oauth_codes(hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
             values ($1,$2,$3,$4,$5,$6,$7,now() + make_interval(secs => $8))`,
      [keyHash(code), a.client_id, user.id, a.redirect_uri, a.code_challenge, a.resource, a.scope, CODE_TTL_S]);
    log.info({ user: user.email, client: client.client_name }, 'oauth: access granted');
    return redirectWith(c, a, { code });
  });

  // Token endpoint (form-encoded per OAuth; JSON accepted too)
  app.post('/oauth/token', async (c) => {
    const h = { ...cors, 'cache-control': 'no-store', pragma: 'no-cache' };
    const err = (e: string, d: string, status: 400 | 401 | 429 = 400) => c.json({ error: e, error_description: d }, status, h);
    const ct = c.req.header('content-type') ?? '';
    const f: Record<string, string> = ct.includes('application/json')
      ? await c.req.json().catch(() => ({}))
      : Object.fromEntries(Object.entries(await c.req.parseBody().catch(() => ({}))).map(([k, v]) => [k, String(v)]));
    const wait = await rateTake(`token:${clientAddr(c)}`, 60, 60);
    if (wait) return err('slow_down', `retry in ${wait}s`, 429);
    const origin = originOf(c.req.raw);
    if (f.grant_type === 'authorization_code') {
      if (!f.code || !f.client_id || !f.code_verifier) return err('invalid_request', 'code, client_id and code_verifier are required');
      // single use: the first exchange wins; a replayed code revokes what it produced (RFC 6749 §4.1.2)
      const row = await one(`update oauth_codes set used_at = now() where hash = $1 and used_at is null returning *, (expires_at < now()) as expired`, [keyHash(f.code)]);
      if (!row) {
        const used = await one<{ grant_id: number | null }>('select grant_id::int as grant_id from oauth_codes where hash = $1', [keyHash(f.code)]);
        if (used?.grant_id) { await revokeGrant(used.grant_id); hooks.closeStreams([-used.grant_id]); log.warn({ grant: used.grant_id }, 'oauth: authorization code replayed; grant revoked'); }
        return err('invalid_grant', 'authorization code unknown or already used');
      }
      if (row.expired) return err('invalid_grant', 'authorization code expired');
      if (row.client_id !== f.client_id) return err('invalid_grant', 'code was issued to another client');
      if (f.redirect_uri !== undefined && f.redirect_uri !== row.redirect_uri) return err('invalid_grant', 'redirect_uri does not match the authorization request');
      const challenge = crypto.createHash('sha256').update(f.code_verifier).digest('base64url');
      if (challenge.length !== row.code_challenge.length || !crypto.timingSafeEqual(Buffer.from(challenge), Buffer.from(row.code_challenge))) return err('invalid_grant', 'PKCE verification failed');
      if (f.resource !== undefined && canonicalResource(f.resource, origin) !== row.resource) return err('invalid_target', 'resource does not match the authorization request');
      const client = await one<{ client_name: string }>('select client_name from oauth_clients where client_id = $1', [row.client_id]);
      const user = await one<{ disabled: boolean }>('select disabled from users where id = $1', [row.user_id]);
      if (!client || !user || user.disabled) return err('invalid_grant', 'client or user no longer valid');
      const g = await one<{ id: number }>(`insert into oauth_grants(user_id, client_id, client_name, redirect_host, resource, scope) values ($1,$2,$3,$4,$5,$6) returning id::int as id`,
        [row.user_id, row.client_id, client.client_name, (() => { try { return new URL(row.redirect_uri).host || row.redirect_uri; } catch { return row.redirect_uri; } })(), row.resource, row.scope]);
      await q('update oauth_codes set grant_id = $2 where hash = $1', [keyHash(f.code), g!.id]);
      return c.json(await issueTokens(g!.id), 200, h);
    }
    if (f.grant_type === 'refresh_token') {
      if (!f.refresh_token || !f.client_id) return err('invalid_request', 'refresh_token and client_id are required');
      const t = await one(`update oauth_tokens set used_at = now() where hash = $1 and kind = 'refresh' and used_at is null returning grant_id::int as grant_id, (expires_at < now()) as expired`, [keyHash(f.refresh_token)]);
      if (!t) {
        // a refresh token used twice was stolen (one copy is the attacker's): end the whole grant (OAuth 2.1 §4.3.1)
        const old = await one<{ grant_id: number }>(`select grant_id::int as grant_id from oauth_tokens where hash = $1 and kind = 'refresh'`, [keyHash(f.refresh_token)]);
        if (old) { await revokeGrant(old.grant_id); hooks.closeStreams([-old.grant_id]); log.warn({ grant: old.grant_id }, 'oauth: refresh token reused; grant revoked'); }
        return err('invalid_grant', 'refresh token unknown, expired or already used');
      }
      if (t.expired) return err('invalid_grant', 'refresh token expired');
      const g = await one(`select g.client_id, g.resource, g.revoked_at, u.disabled from oauth_grants g join users u on u.id = g.user_id where g.id = $1`, [t.grant_id]);
      if (!g || g.revoked_at || g.disabled) return err('invalid_grant', 'access was revoked');
      if (g.client_id !== f.client_id) return err('invalid_grant', 'refresh token was issued to another client');
      if (f.resource !== undefined && canonicalResource(f.resource, origin) !== g.resource) return err('invalid_target', 'resource does not match the grant');
      await q(`delete from oauth_tokens where grant_id = $1 and kind = 'access'`, [t.grant_id]); // one live access token per grant
      return c.json(await issueTokens(t.grant_id), 200, h);
    }
    return err('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  // Revocation (RFC 7009): always 200; revoking either token ends the grant
  app.post('/oauth/revoke', async (c) => {
    const f = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const token = String(f.token ?? '');
    const t = token ? await one<{ grant_id: number }>('select grant_id::int as grant_id from oauth_tokens where hash = $1', [keyHash(token)]) : undefined;
    if (t) { await revokeGrant(t.grant_id); hooks.closeStreams([-t.grant_id]); }
    return c.body(null, 200, cors);
  });

  return app;
}

// ---- dashboard API: your connected apps (admins: everyone's) ----
export function oauthApi(api: Hono<any>, hooks: { closeStreams: (ids: number[]) => void }) {
  const COLS = `g.id::int as id, g.client_id as "clientId", g.client_name as "clientName", g.redirect_host as "redirectHost", g.created_at as "createdAt",
    g.last_used_at as "lastUsedAt", g.revoked_at as "revokedAt", u.email as "userEmail", (c.kind = 'cimd') as verified`;
  api.get('/oauth/grants', async (c) => {
    const u = c.get('user');
    const all = c.req.query('all') === '1' && u.role === 'admin';
    return c.json(await q(`select ${COLS} from oauth_grants g join users u on u.id = g.user_id left join oauth_clients c on c.client_id = g.client_id
      ${all ? '' : 'where g.user_id = $1'} order by g.id desc limit 200`, all ? [] : [u.id]));
  });
  api.delete('/oauth/grants/:id', async (c) => {
    const u = c.get('user');
    const v = c.req.param('id') ?? '';
    if (!/^[1-9]\d{0,15}$/.test(v)) return c.json({ error: 'no such grant' }, 404);
    const r = await one(`select id from oauth_grants where id = $1 ${u.role === 'admin' ? '' : 'and user_id = $2'}`, u.role === 'admin' ? [Number(v)] : [Number(v), u.id]);
    if (!r) return c.json({ error: 'no such grant' }, 404);
    await revokeGrant(Number(v));
    hooks.closeStreams([-Number(v)]);
    return c.body(null, 204);
  });
}
