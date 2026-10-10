// Admin REST API for the dashboard (contract: docs/api.md). Session cookie + CSRF header; roles admin/member.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import * as z from 'zod';
import { config } from './config.js';
import { one, q } from './db.js';
import {
  createKey, createSession, deleteSession, hashPassword, randomPassword, sessionUser, verifyPassword, type User,
} from './auth.js';
import type { Upstream, UpstreamManager, UpstreamRow } from './upstreams.js';
import { seal } from './sealed.js';
import { publish } from './events.js';

type Env = { Variables: { user: User & { csrf: string } } };
const COOKIE = 'urumi_session';

export function serverView(u: Upstream) {
  return {
    id: u.id, slug: u.slug, name: u.name, url: u.url, enabled: u.enabled, status: u.status, era: u.era,
    protocolVersion: u.protocolVersion, lastError: u.lastError, statusSince: u.statusSince.toISOString(),
    timeoutMs: u.timeoutMs, hasCredential: !!u.credential, authHeader: u.authHeader,
    tools: u.tools.map((t) => ({ name: t.name, gatewayName: `${u.slug}__${t.name}`, title: t.title, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema, access: u.access.get(t.name) ?? 'member',
      changed: u.changed.has(t.name), approvedDescription: u.changed.has(t.name) ? u.pins.get(t.name)?.description ?? null : undefined })),
  };
}

const bad = (c: Context, status: 400 | 401 | 403 | 404 | 409, error: string) => c.json({ error }, status);
async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return bad(c, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return parsed.data;
}

const upstreamUrl = z.string().url().max(500).refine((s) => /^https?:\/\//.test(s), 'must be http(s)');
const serverIn = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lowercase letters, digits, dashes (2-31 chars)').refine((s) => !s.includes('__'), 'no "__"').refine((s) => s !== 'gateway', '"gateway" is reserved'),
  url: upstreamUrl,
  authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullish(),
  credential: z.string().max(4000).nullish(),
  timeoutMs: z.number().int().min(1000).max(600_000).nullish(),
});
const serverPatch = z.object({
  name: z.string().trim().min(1).max(80), url: upstreamUrl, enabled: z.boolean(),
  authHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).nullable(), credential: z.string().max(4000).nullable(),
  timeoutMs: z.number().int().min(1000).max(600_000).nullable(),
}).partial();
const UP_COLS = 'id::int as id, slug, name, url, auth_header, credential, enabled, timeout_ms';

export function createApi(mgr: UpstreamManager, hooks: { closeKeyStreams: (keyId: number) => void }) {
  const api = new Hono<Env>();

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const user = await sessionUser(getCookie(c, COOKIE));
    if (!user) return bad(c, 401, 'not logged in');
    if (c.req.method !== 'GET' && c.req.header('x-csrf-token') !== user.csrf) return bad(c, 403, 'missing or wrong CSRF token');
    c.set('user', user);
    await next();
  };
  const admin: MiddlewareHandler<Env> = async (c, next) => {
    if (c.get('user').role !== 'admin') return bad(c, 403, 'admin only');
    await next();
  };
  const me = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

  api.get('/info', (c) => c.json({ mcpUrl: `${config.publicUrl}/mcp`, version: config.version, chat: { enabled: !!config.llmBaseUrl, model: config.llmModel } }));

  api.post('/auth/login', async (c) => {
    const b = await body(c, z.object({ email: z.string().max(200), password: z.string().max(200) }));
    if (b instanceof Response) return b;
    const u = await one<User & { password_hash: string }>('select id::int as id, email, name, role, disabled, password_hash from users where email = $1', [b.email.trim().toLowerCase()]);
    if (!u || u.disabled || !(await verifyPassword(b.password, u.password_hash))) return bad(c, 401, 'wrong email or password');
    const s = await createSession(u.id);
    setCookie(c, COOKIE, s.token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: config.cookieSecure, maxAge: config.sessionHours * 3600 });
    return c.json({ user: me(u), csrf: s.csrf });
  });

  api.use('/*', async (c, next) => (c.req.path.endsWith('/auth/login') || c.req.path.endsWith('/info') ? next() : auth(c, next)));

  api.post('/auth/logout', async (c) => {
    const t = getCookie(c, COOKIE);
    if (t) await deleteSession(t);
    deleteCookie(c, COOKIE, { path: '/' });
    return c.body(null, 204);
  });
  api.get('/me', (c) => c.json({ user: me(c.get('user')), csrf: c.get('user').csrf }));

  // ---- servers ----
  api.get('/servers', (c) => c.json([...mgr.ups.values()].sort((a, b) => a.id - b.id).map(serverView)));
  api.post('/servers', admin, async (c) => {
    const b = await body(c, serverIn);
    if (b instanceof Response) return b;
    if (await one('select 1 from upstreams where slug = $1', [b.slug])) return bad(c, 409, `slug "${b.slug}" is taken`);
    const authHeader = b.credential ? (b.authHeader || 'Authorization') : null;
    const r = await one<UpstreamRow>(`insert into upstreams(slug, name, url, auth_header, credential, timeout_ms, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning ${UP_COLS}`,
      [b.slug, b.name, b.url, authHeader, seal(b.credential), b.timeoutMs ?? null, c.get('user').id]);
    const u = mgr.upsert(r!);
    publish({ t: 'upstream', id: u.id });
    await waitSettled(u, 6000);
    return c.json(serverView(u), 201);
  });
  api.patch('/servers/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    const b = await body(c, serverPatch);
    if (b instanceof Response) return b;
    const cur = await one<UpstreamRow>(`select ${UP_COLS} from upstreams where id = $1`, [id]);
    if (!cur) return bad(c, 404, 'no such server');
    const next = {
      name: b.name ?? cur.name, url: b.url ?? cur.url, enabled: b.enabled ?? cur.enabled,
      credential: b.credential === undefined ? cur.credential : seal(b.credential), // cur.credential is already sealed
      timeout_ms: b.timeoutMs === undefined ? cur.timeout_ms : b.timeoutMs,
      auth_header: b.authHeader === undefined ? cur.auth_header : b.authHeader,
    };
    if (next.credential && !next.auth_header) next.auth_header = 'Authorization';
    const r = await one<UpstreamRow>(`update upstreams set name=$2, url=$3, enabled=$4, credential=$5, timeout_ms=$6, auth_header=$7 where id=$1 returning ${UP_COLS}`,
      [id, next.name, next.url, next.enabled, next.credential, next.timeout_ms, next.auth_header]);
    const u = mgr.upsert(r!);
    publish({ t: 'upstream', id });
    if (u.enabled) await waitSettled(u, 4000);
    return c.json(serverView(u));
  });
  api.delete('/servers/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    await q('delete from upstreams where id = $1', [id]);
    mgr.remove(id);
    publish({ t: 'upstream', id });
    return c.body(null, 204);
  });
  api.put('/servers/:id/tools/:tool/access', admin, async (c) => {
    const u = mgr.ups.get(Number(c.req.param('id')));
    if (!u) return bad(c, 404, 'no such server');
    const b = await body(c, z.object({ access: z.enum(['member', 'admin', 'off']) }));
    if (b instanceof Response) return b;
    await mgr.setAccess(u, c.req.param('tool'), b.access);
    publish({ t: 'access', id: u.id, tool: c.req.param('tool') });
    return c.json(serverView(u));
  });
  api.post('/servers/:id/tools/:tool/approve', admin, async (c) => {
    const u = mgr.ups.get(Number(c.req.param('id')));
    if (!u) return bad(c, 404, 'no such server');
    if (!(await mgr.approveTool(u, c.req.param('tool')))) return bad(c, 404, 'no such tool');
    publish({ t: 'pin', id: u.id, tool: c.req.param('tool') });
    return c.json(serverView(u));
  });
  api.get('/servers/:id/events', async (c) =>
    c.json(await q(`select at, status, error from upstream_events where upstream_id = $1 order by id desc limit 50`, [Number(c.req.param('id'))])));

  // ---- members ----
  const MEMBER = `id::int as id, email, name, role, disabled, created_at as "createdAt"`;
  api.get('/members', async (c) => c.json(await q(`select ${MEMBER} from users order by id`)));
  api.post('/members', admin, async (c) => {
    const b = await body(c, z.object({ email: z.string().email().max(200), name: z.string().trim().max(80).default(''), role: z.enum(['admin', 'member']) }));
    if (b instanceof Response) return b;
    const password = randomPassword();
    const r = await one(`insert into users(email, name, role, password_hash) values ($1,$2,$3,$4) on conflict (email) do nothing returning ${MEMBER}`,
      [b.email.toLowerCase(), b.name, b.role, await hashPassword(password)]);
    if (!r) return bad(c, 409, 'a member with that email exists');
    return c.json({ member: r, password }, 201);
  });
  api.patch('/members/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    const b = await body(c, z.object({ role: z.enum(['admin', 'member']), disabled: z.boolean(), name: z.string().trim().max(80) }).partial());
    if (b instanceof Response) return b;
    if (id === c.get('user').id && (b.disabled || b.role === 'member')) return bad(c, 400, 'you cannot demote or disable yourself');
    const r = await one(`update users set role = coalesce($2, role), disabled = coalesce($3, disabled), name = coalesce($4, name) where id = $1 returning ${MEMBER}`,
      [id, b.role ?? null, b.disabled ?? null, b.name ?? null]);
    if (!r) return bad(c, 404, 'no such member');
    if (b.disabled) await revokeUserKeys(id);
    return c.json(r);
  });
  api.delete('/members/:id', admin, async (c) => {
    const id = Number(c.req.param('id'));
    if (id === c.get('user').id) return bad(c, 400, 'you cannot delete yourself');
    await revokeUserKeys(id);
    await q('delete from users where id = $1', [id]);
    return c.body(null, 204);
  });
  async function revokeUserKeys(userId: number) {
    const rows = await q<{ id: number }>('update api_keys set revoked_at = now() where user_id = $1 and revoked_at is null returning id::int as id', [userId]);
    await q('delete from sessions where user_id = $1', [userId]);
    rows.forEach((r) => hooks.closeKeyStreams(r.id));
    if (rows.length) publish({ t: 'revoke', keyIds: rows.map((r) => r.id) });
  }

  // ---- API keys ----
  const KEY = `k.id::int as id, k.name, k.prefix, k.user_id::int as "userId", u.email as "userEmail", k.created_at as "createdAt", k.last_used_at as "lastUsedAt", k.revoked_at as "revokedAt"`;
  api.get('/keys', async (c) => {
    const u = c.get('user');
    const all = c.req.query('all') === '1' && u.role === 'admin';
    return c.json(await q(`select ${KEY} from api_keys k join users u on u.id = k.user_id ${all ? '' : 'where k.user_id = $1'} order by k.id desc`, all ? [] : [u.id]));
  });
  api.post('/keys', async (c) => {
    const b = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
    if (b instanceof Response) return b;
    const { id, secret } = await createKey(c.get('user').id, b.name);
    return c.json({ key: await one(`select ${KEY} from api_keys k join users u on u.id = k.user_id where k.id = $1`, [id]), secret }, 201);
  });
  api.delete('/keys/:id', async (c) => {
    const u = c.get('user');
    const id = Number(c.req.param('id'));
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
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (u.role !== 'admin') add('user_id = ?', u.id);
    if (c.req.query('before')) add('id < ?', Number(c.req.query('before')));
    if (c.req.query('user')) add('user_email = ?', c.req.query('user'));
    if (c.req.query('server')) add('server = ?', c.req.query('server'));
    if (c.req.query('outcome')) add('outcome = ?', c.req.query('outcome'));
    params.push(limit);
    const items = await q(`select id::int as id, at, user_email as "userEmail", via, server, tool, duration_ms as "durationMs", outcome, error, era, client
      from audit_log ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit $${params.length}`, params);
    return c.json({ items, nextBefore: items.length === limit ? items[items.length - 1].id : null });
  });

  return api;
}

/** After add/edit, wait briefly for the first probe so the response already shows Connected/Unreachable. */
async function waitSettled(u: Upstream, ms: number) {
  const t0 = Date.now();
  while (u.status === 'connecting' && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
}
