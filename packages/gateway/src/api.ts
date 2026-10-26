// Admin REST API for the dashboard (contract: docs/api.md). Session cookie + CSRF header; roles admin/member.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import * as z from 'zod';
import { config } from './config.js';
import { one, q } from './db.js';
import {
  createKey, createSession, deleteSession, endSessions, passwordLogin, passwordProblem, randomPassword, sessionUser,
  setPassword, verifyPassword, hashPassword, type User,
} from './auth.js';
import { redactUrl, UPSTREAM_COLS, type Upstream, type UpstreamManager, type UpstreamRow } from './upstreams.js';
import { seal } from './sealed.js';
import { RESERVED_SLUGS } from '@urumi/shared';
import { publish } from './events.js';

type Env = { Variables: { user: User & { csrf: string; sid: string } } };
const COOKIE = 'urumi_session';

/** A server as the dashboard sees it. Never the credential; for members, not even URL userinfo or query values
 *  (some hosted MCP servers take their key in the query string). */
export function serverView(u: Upstream, viewer: { role: string } = { role: 'admin' }) {
  const admin = viewer.role === 'admin';
  const hide = (s: string | null) => (s && !admin ? s.split(u.url).join(redactUrl(u.url)) : s);
  return {
    id: u.id, slug: u.slug, name: u.name, url: admin ? u.url : redactUrl(u.url), enabled: u.enabled, status: u.status, era: u.era,
    protocolVersion: u.protocolVersion, lastError: hide(u.lastError), statusSince: u.statusSince.toISOString(),
    timeoutMs: u.timeoutMs, hasCredential: !!u.credential || !!u.credentialError, authHeader: u.authHeader, managed: !!u.managedBy,
    tools: u.tools.map((t) => ({ name: t.name, gatewayName: `${u.slug}__${u.exposedOf.get(t.name) ?? t.name}`, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema, access: u.access.get(t.name) ?? 'member',
      changed: u.changed.has(t.name), change: u.changed.has(t.name) ? (u.pins.has(t.name) ? 'changed' : 'new') : undefined,
      approvedDescription: u.changed.has(t.name) ? u.pins.get(t.name)?.description ?? null : undefined })),
  };
}

/** A route :id that is a positive integer, else 0 (matches nothing: every lookup then answers 404). */
const pid = (c: Context) => { const v = c.req.param('id') ?? ''; return /^[1-9]\d{0,15}$/.test(v) ? Number(v) : 0; };
const bad = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, error: string, headers?: Record<string, string>) => c.json({ error }, status, headers);
/** The client address as Traefik saw it (first X-Forwarded-For hop), for the failed-login budget. */
const clientAddr = (c: Context) => (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() || c.req.header('x-real-ip') || 'direct';
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return bad(c, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return parsed.data;
}

const upstreamUrl = z.string().trim().url().max(500)
  .refine((s) => /^https?:\/\//i.test(s), 'must be http(s)')
  .refine((s) => { try { const u = new URL(s); return !u.username && !u.password; } catch { return false; } },
    'no user:password@ in the URL: put credentials in the credential field (stored encrypted)')
  .refine((s) => !s.includes('#'), 'no #fragment');
/** Slugs nobody may register (the gateway's own meta-tools, hostnames the chart uses). */
const RESERVED = new Set<string>(RESERVED_SLUGS);
// Headers the transport owns or that would change where/how the request goes: never settable as a "credential".
const RESERVED_HEADERS = new Set(['host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'accept', 'te',
  'upgrade', 'expect', 'cookie', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'origin', 'proxy-authorization', 'forwarded']);
const authHeader = z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'a header name (letters, digits, dashes)')
  .refine((h) => !RESERVED_HEADERS.has(h.toLowerCase()) && !h.toLowerCase().startsWith('x-forwarded-'), 'that header is managed by the gateway');
// a header value: printable, no CR/LF (header injection)
const credential = z.string().max(4000).refine((v) => !/[\r\n\0]/.test(v), 'no line breaks');
const serverIn = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lowercase letters, digits, dashes (2-31 chars)').refine((s) => !s.includes('__'), 'no "__"').refine((s) => !RESERVED.has(s), 'that slug is reserved'),
  url: upstreamUrl,
  authHeader: authHeader.nullish(),
  credential: credential.nullish(),
  timeoutMs: z.number().int().min(1000).max(600_000).nullish(),
});
const serverPatch = z.object({
  name: z.string().trim().min(1).max(80), url: upstreamUrl, enabled: z.boolean(),
  authHeader: authHeader.nullable(), credential: credential.nullable(),
  timeoutMs: z.number().int().min(1000).max(600_000).nullable(),
}).partial();
const UP_COLS = UPSTREAM_COLS;

export interface ApiHooks {
  closeKeyStreams: (keyId: number) => void;
  /** Revoke every OAuth grant of a user (disable/delete); returns the closed stream ids. */
  revokeUserGrants?: (userId: number) => Promise<number[]>;
  /** More authenticated routes (OAuth connected apps, provisioning). */
  extend?: (api: Hono<Env>) => void;
}

export function createApi(mgr: UpstreamManager, hooks: ApiHooks) {
  const api = new Hono<Env>();

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const user = await sessionUser(getCookie(c, COOKIE));
    if (!user) return bad(c, 401, 'not logged in');
    if (c.req.method !== 'GET' && c.req.header('x-csrf-token') !== user.csrf) return bad(c, 403, 'missing or wrong CSRF token');
    // a temporary password must be replaced before anything else
    if (user.mustChangePassword && !c.req.path.endsWith('/auth/password') && !c.req.path.endsWith('/auth/logout') && !c.req.path.endsWith('/me'))
      return bad(c, 403, 'change your temporary password first');
    c.set('user', user);
    await next();
  };
  const admin: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('user').role !== 'admin') return bad(c, 403, 'admin only');
    await next();
  };
  const me = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, mustChangePassword: !!u.mustChangePassword });

  api.get('/info', (c) => c.json({ mcpUrl: `${config.publicUrl}/mcp`, version: config.version, chat: { enabled: !!config.llmBaseUrl, model: config.llmModels.join(', ') } }));

  api.post('/auth/login', async (c) => {
    const b = await body(c, z.object({ email: z.string().max(200), password: z.string().max(200) }));
    if (b instanceof Response) return b;
    const r = await passwordLogin(b.email, b.password, clientAddr(c));
    if ('wait' in r) return bad(c, 429, `too many failed sign-ins; try again in ${r.wait}s`, { 'retry-after': String(r.wait) });
    if ('error' in r) return bad(c, 401, 'wrong email or password');
    const s = await createSession(r.user.id);
    setCookie(c, COOKIE, s.token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: config.cookieSecure, maxAge: config.sessionHours * 3600 });
    return c.json({ user: me(r.user), csrf: s.csrf });
  });

  api.use('/*', async (c, next) => (c.req.path.endsWith('/auth/login') || c.req.path.endsWith('/info') ? next() : auth(c, next)));

  api.post('/auth/logout', async (c) => {
    const t = getCookie(c, COOKIE);
    if (t) await deleteSession(t);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  api.get('/me', (c) => c.json({ user: me(c.get('user')), csrf: c.get('user').csrf }));

  // Change your own password (also how a temporary one is replaced). Other sessions of this user end.
  api.post('/auth/password', async (c) => {
    const b = await body(c, z.object({ current: z.string().max(200), password: z.string().max(200) }));
    if (b instanceof Response) return b;
    const u = c.get('user');
    const row = await one<{ password_hash: string }>('select password_hash from users where id = $1', [u.id]);
    if (!row || !(await verifyPassword(b.current, row.password_hash))) return bad(c, 403, 'current password is wrong');
    const problem = passwordProblem(b.password);
    if (problem) return bad(c, 400, problem);
    if (b.password === b.current) return bad(c, 400, 'choose a new password');
    await setPassword(u.id, b.password, false);
    await endSessions(u.id, getCookie(c, COOKIE));
    return c.body(null, 204);
  });

  // ---- servers ----
  api.get('/servers', (c) => c.json([...mgr.ups.values()].sort((a, b) => a.id - b.id).map((u) => serverView(u, c.get('user')))));
  api.post('/servers', admin, async (c) => {
    const b = await body(c, serverIn);
    if (b instanceof Response) return b;
    if (RESERVED.has(b.slug)) return bad(c, 409, `slug "${b.slug}" is reserved`);
    if (await one('select 1 from provisions where slug = $1', [b.slug])) return bad(c, 409, `slug "${b.slug}" belongs to a store or hosted server`);
    const authHeader = b.credential ? (b.authHeader || 'Authorization') : null;
    // `on conflict do nothing`: two admins adding the same slug at once get a clean 409, not a 500
    const r = await one<UpstreamRow>(`insert into upstreams(slug, name, url, auth_header, credential, timeout_ms, created_by) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (slug) do nothing returning ${UP_COLS}`,
      [b.slug, b.name, b.url, authHeader, seal(b.credential), b.timeoutMs ?? null, c.get('user').id]);
    if (!r) return bad(c, 409, `slug "${b.slug}" is taken`);
    const u = mgr.upsert(r);
    publish({ t: 'upstream', id: u.id });
    await waitSettled(u, 6000);
    return c.json(serverView(u, c.get('user')), 201);
  });
  api.patch('/servers/:id', admin, async (c) => {
    const id = pid(c);
    const b = await body(c, serverPatch);
    if (b instanceof Response) return b;
    const cur = await one<UpstreamRow>(`select ${UP_COLS} from upstreams where id = $1`, [id]);
    if (!cur) return bad(c, 404, 'no such server');
    if (cur.managed_by && (b.url !== undefined || b.credential !== undefined || b.authHeader !== undefined))
      return bad(c, 400, 'this server belongs to a store or hosted server: its URL and credential are managed by the provisioner');
    const next = {
      name: b.name ?? cur.name, url: b.url ?? cur.url, enabled: b.enabled ?? cur.enabled,
      credential: b.credential === undefined ? cur.credential : seal(b.credential), // cur.credential is already sealed
      timeout_ms: b.timeoutMs === undefined ? cur.timeout_ms : b.timeoutMs,
      auth_header: b.authHeader === undefined ? cur.auth_header : b.authHeader,
    };
    if (next.credential && !next.auth_header) next.auth_header = 'Authorization';
    if (!next.credential) next.auth_header = null;
    // a stored credential never silently follows the server to another host (typo, or a hijacked admin session)
    if (cur.credential && b.credential === undefined && new URL(next.url).origin !== new URL(cur.url).origin)
      return bad(c, 400, 'the server moves to another host: enter its credential again (or remove it)');
    const r = await one<UpstreamRow>(`update upstreams set name=$2, url=$3, enabled=$4, credential=$5, timeout_ms=$6, auth_header=$7 where id=$1 returning ${UP_COLS}`,
      [id, next.name, next.url, next.enabled, next.credential, next.timeout_ms, next.auth_header]);
    if (!r) return bad(c, 404, 'no such server');
    // pointed at a different server: the old server's approved tool definitions don't apply to the new one
    const existing = mgr.ups.get(id);
    if (existing && next.url !== cur.url) await mgr.resetPins(existing);
    const u = mgr.upsert(r);
    publish({ t: 'upstream', id });
    if (u.enabled) await waitSettled(u, 4000);
    return c.json(serverView(u, c.get('user')));
  });
  api.delete('/servers/:id', admin, async (c) => {
    const id = pid(c);
    const m = await one<{ managed_by: string | null }>('select managed_by from upstreams where id = $1', [id]);
    if (!m) return bad(c, 404, 'no such server');
    if (m.managed_by) return bad(c, 409, 'this server belongs to a store or hosted server: delete that instead');
    const r = await one('delete from upstreams where id = $1 returning id', [id]);
    if (!r) return bad(c, 404, 'no such server');
    mgr.remove(id);
    publish({ t: 'upstream', id });
    return c.body(null, 204);
  });
  const toolOf = (u: Upstream, tool: string) => u.tools.some((t) => t.name === tool) || u.access.has(tool) || u.pins.has(tool);
  api.put('/servers/:id/tools/:tool/access', admin, async (c) => {
    const u = mgr.ups.get(pid(c));
    if (!u) return bad(c, 404, 'no such server');
    const tool = c.req.param('tool');
    if (!toolOf(u, tool)) await mgr.refreshTools(u);
    if (!toolOf(u, tool)) return bad(c, 404, 'no such tool');
    const b = await body(c, z.object({ access: z.enum(['member', 'admin', 'off']) }));
    if (b instanceof Response) return b;
    await mgr.setAccess(u, tool, b.access);
    publish({ t: 'access', id: u.id, tool });
    return c.json(serverView(u, c.get('user')));
  });
  api.post('/servers/:id/tools/:tool/approve', admin, async (c) => {
    const u = mgr.ups.get(pid(c));
    if (!u) return bad(c, 404, 'no such server');
    // the dashboard may have shown this tool from another replica: re-list here before calling it unknown
    if (!u.tools.some((t) => t.name === c.req.param('tool'))) await mgr.refreshTools(u);
    if (!(await mgr.approveTool(u, c.req.param('tool')))) return bad(c, 404, 'no such tool');
    publish({ t: 'pin', id: u.id, tool: c.req.param('tool') });
    return c.json(serverView(u, c.get('user')));
  });
  // After an upgrade of the server itself, several definitions change at once: approve every pending one.
  api.post('/servers/:id/approve-all', admin, async (c) => {
    const u = mgr.ups.get(pid(c));
    if (!u) return bad(c, 404, 'no such server');
    await mgr.refreshTools(u); // see what the admin saw, even if another replica noticed the changes first
    const tools = [...u.changed];
    for (const t of tools) {
      await mgr.approveTool(u, t);
      publish({ t: 'pin', id: u.id, tool: t });
    }
    return c.json({ approved: tools, server: serverView(u, c.get('user')) });
  });
  api.get('/servers/:id/events', async (c) => {
    const u = mgr.ups.get(pid(c));
    if (!u) return bad(c, 404, 'no such server');
    const rows = await q<{ at: string; status: string; error: string | null }>(`select at, status, error from upstream_events where upstream_id = $1 order by id desc limit 50`, [u.id]);
    const admin = c.get('user').role === 'admin';
    return c.json(admin ? rows : rows.map((e) => ({ ...e, error: e.error ? e.error.split(u.url).join(redactUrl(u.url)) : e.error })));
  });

  // ---- members ----
  const MEMBER = `id::int as id, email, name, role, disabled, created_at as "createdAt"`;
  api.get('/members', async (c) => c.json(await q(`select ${MEMBER} from users order by id`)));
  api.post('/members', admin, async (c) => {
    const b = await body(c, z.object({ email: z.string().trim().email().max(200), name: z.string().trim().max(80).default(''), role: z.enum(['admin', 'member']) }));
    if (b instanceof Response) return b;
    const password = randomPassword();
    // the invite password is temporary: the member must replace it at first sign-in
    const r = await one(`insert into users(email, name, role, password_hash, must_change_password) values ($1,$2,$3,$4,true) on conflict (email) do nothing returning ${MEMBER}`,
      [b.email.toLowerCase(), b.name, b.role, await hashPassword(password)]);
    if (!r) return bad(c, 409, 'a member with that email exists');
    return c.json({ member: r, password }, 201);
  });
  api.patch('/members/:id', admin, async (c) => {
    const id = pid(c);
    const b = await body(c, z.object({ role: z.enum(['admin', 'member']), disabled: z.boolean(), name: z.string().trim().max(80) }).partial());
    if (b instanceof Response) return b;
    if (id === c.get('user').id && (b.disabled || b.role === 'member')) return bad(c, 400, 'you cannot demote or disable yourself');
    const r = await one(`update users set role = coalesce($2, role), disabled = coalesce($3, disabled), name = coalesce($4, name) where id = $1 returning ${MEMBER}`,
      [id, b.role ?? null, b.disabled ?? null, b.name ?? null]);
    if (!r) return bad(c, 404, 'no such member');
    if (b.disabled) await revokeUserKeys(id);
    return c.json(r);
  });
  // Admin reset: a new temporary password (shown once), every session ends; keys stay valid.
  api.post('/members/:id/reset-password', admin, async (c) => {
    const id = pid(c);
    if (id === c.get('user').id) return bad(c, 400, 'change your own password under your account instead');
    const password = randomPassword();
    const r = await one(`update users set password_hash = $2, must_change_password = true where id = $1 returning ${MEMBER}`, [id, await hashPassword(password)]);
    if (!r) return bad(c, 404, 'no such member');
    await endSessions(id);
    return c.json({ member: r, password });
  });
  api.delete('/members/:id', admin, async (c) => {
    const id = pid(c);
    if (id === c.get('user').id) return bad(c, 400, 'you cannot delete yourself');
    if (!(await one('select 1 from users where id = $1', [id]))) return bad(c, 404, 'no such member');
    await revokeUserKeys(id);
    await q('delete from users where id = $1', [id]);
    return c.body(null, 204);
  });
  async function revokeUserKeys(userId: number) {
    const rows = await q<{ id: number }>('update api_keys set revoked_at = now() where user_id = $1 and revoked_at is null returning id::int as id', [userId]);
    await endSessions(userId);
    const ids = [...rows.map((r) => r.id), ...((await hooks.revokeUserGrants?.(userId)) ?? [])];
    ids.forEach((id) => hooks.closeKeyStreams(id));
    if (ids.length) publish({ t: 'revoke', keyIds: ids });
  }

  // ---- API keys ----
  const KEY = `k.id::int as id, k.name, k.prefix, k.user_id::int as "userId", u.email as "userEmail", k.created_at as "createdAt", k.last_used_at as "lastUsedAt", k.revoked_at as "revokedAt"`;
  api.get('/keys', async (c) => {
    const u = c.get('user');
    const all = c.req.query('all') === '1' && u.role === 'admin';
    return c.json(await q(`select ${KEY} from api_keys k join users u on u.id = k.user_id ${all ? '' : 'where k.user_id = $1'} order by k.id desc`, all ? [] : [u.id]));
  });
  // Your own key; an admin may also issue one for another member (shown once to the admin, who hands it over).
  api.post('/keys', async (c) => {
    const b = await body(c, z.object({ name: z.string().trim().min(1).max(60), userId: z.number().int().positive().optional() }));
    if (b instanceof Response) return b;
    const me = c.get('user');
    const owner = b.userId ?? me.id;
    if (owner !== me.id && me.role !== 'admin') return bad(c, 403, 'only admins can issue keys for other members');
    const target = await one<{ disabled: boolean }>('select disabled from users where id = $1', [owner]);
    if (!target) return bad(c, 404, 'no such member');
    if (target.disabled) return bad(c, 409, 'that member is disabled');
    const n = await one<{ n: number }>('select count(*)::int as n from api_keys where user_id = $1 and revoked_at is null', [owner]);
    if ((n?.n ?? 0) >= config.maxKeysPerUser) return bad(c, 409, `at most ${config.maxKeysPerUser} active keys per member: revoke an unused one first`);
    const { id, secret } = await createKey(owner, b.name);
    return c.json({ key: await one(`select ${KEY} from api_keys k join users u on u.id = k.user_id where k.id = $1`, [id]), secret }, 201);
  });
  api.delete('/keys/:id', async (c) => {
    const u = c.get('user');
    const id = pid(c);
    const r = await one(`update api_keys set revoked_at = coalesce(revoked_at, now()) where id = $1 ${u.role === 'admin' ? '' : 'and user_id = $2'} returning id`,
      u.role === 'admin' ? [id] : [id, u.id]);
    if (!r) return bad(c, 404, 'no such key');
    hooks.closeKeyStreams(id);
    publish({ t: 'revoke', keyIds: [id] });
    return c.body(null, 204);
  });

  // ---- per-server activity, last hour (from the audit log, so it covers every replica) ----
  api.get('/stats', async (c) => {
    const u = c.get('user');
    const rows = await q(`select server, count(*)::int as calls,
        count(*) filter (where outcome not in ('ok','tool_error'))::int as failures,
        count(*) filter (where outcome = 'tool_error')::int as "toolErrors",
        round(percentile_cont(0.5) within group (order by duration_ms))::int as p50,
        round(percentile_cont(0.95) within group (order by duration_ms))::int as p95,
        max(at) as "lastCall"
      from audit_log where at > now() - interval '1 hour' ${u.role === 'admin' ? '' : 'and user_id = $1'}
      group by server order by server`, u.role === 'admin' ? [] : [u.id]);
    return c.json(rows);
  });

  // ---- audit ----
  api.get('/audit', async (c) => {
    const u = c.get('user');
    const n = Math.trunc(Number(c.req.query('limit') ?? 100));
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (u.role !== 'admin') add('user_id = ?', u.id);
    const before = c.req.query('before');
    if (before) {
      if (!/^\d{1,16}$/.test(before)) return bad(c, 400, 'before must be an audit entry id');
      add('id < ?', Number(before));
    }
    if (c.req.query('user')) add('user_email = ?', c.req.query('user'));
    if (c.req.query('server')) add('server = ?', c.req.query('server'));
    if (c.req.query('outcome')) add('outcome = ?', c.req.query('outcome'));
    params.push(limit);
    const items = await q(`select id::int as id, at, user_email as "userEmail", via, server, tool, duration_ms as "durationMs", outcome, error, era, client
      from audit_log ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit $${params.length}`, params);
    return c.json({ items, nextBefore: items.length === limit ? items[items.length - 1].id : null });
  });

  hooks.extend?.(api);
  return api;
}

/** After add/edit, wait briefly for the first probe so the response already shows Connected/Unreachable. */
async function waitSettled(u: Upstream, ms: number) {
  const t0 = Date.now();
  while (u.status === 'connecting' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
}
