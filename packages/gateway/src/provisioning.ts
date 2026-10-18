// Dashboard API for provisioned resources: WooCommerce stores (any user, a few each) and hosted MCP servers (admins:
// "add a server by container image"). The gateway only records the desired state in Postgres and wakes the
// provisioner (pg_notify); the provisioner, a separate component with its own narrowly-scoped Kubernetes access,
// does the work and reports status, step and failure reason back in the same row. The gateway itself never gets
// write access to the cluster.
import type { Hono } from 'hono';
import * as z from 'zod';
import { RESERVED_SLUGS, SLUG_RE } from '@urumi/shared';
import { config } from './config.js';
import type pg from 'pg';
import { one, pool, q } from './db.js';
import { seal } from './sealed.js';

export const PROVISION_CHANNEL = 'urumi_provision';
const wake = (id: number) => q('select pg_notify($1, $2)', [PROVISION_CHANNEL, String(id)]).catch(() => {});

const COLS = `p.id::int as id, p.kind, p.slug, p.name, p.owner_id::int as "ownerId", p.owner_email as "ownerEmail", p.status, p.step,
  p.reason, p.namespace, p.url, p.timeout_s as "timeoutS", p.attempts, p.created_at as "createdAt", p.started_at as "startedAt",
  p.ready_at as "readyAt", p.updated_at as "updatedAt", p.spec, u.id::int as "upstreamId"`;
const FROM = `from provisions p left join upstreams u on u.managed_by = 'provision:' || p.id`;

const slug = z.string().trim().regex(SLUG_RE, 'lowercase letters, digits, dashes (2-31 chars, letter first)')
  .refine((s) => !s.includes('--') && !s.endsWith('-'), 'no "--" and no trailing dash')
  .refine((s) => !RESERVED_SLUGS.includes(s), 'that name is reserved');
// A store's name reaches every user's model (woo-mcp tool descriptions say "…in the <name> store"): a member must not
// be able to plant instructions there, so names are short and plain.
const displayName = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} &'.,()-]*$/u, "letters, digits, spaces and & ' . , ( ) - only (at most 40)");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'env names: A-Z, 0-9, _');
const envMap = z.record(envName, z.string().max(4000).refine((v) => !/\0/.test(v), 'no NUL')).refine((m) => Object.keys(m).length <= 30, 'at most 30 variables');
// a pullable image reference with an explicit tag or digest (no implicit :latest)
const image = z.string().trim().max(300)
  .regex(/^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[\w][\w.-]{0,127}|@sha256:[a-f0-9]{64})$/, 'an image reference with a tag or digest, e.g. ghcr.io/org/server:1.2.3')
  .refine((i) => !/:latest$/.test(i), 'pin a version instead of :latest');

async function slugTaken(s: string, tx: pg.PoolClient) {
  return (await tx.query('select 1 from upstreams where slug = $1 union all select 1 from provisions where slug = $1 limit 1', [s])).rowCount! > 0;
}
/** Run `fn` in a transaction holding the provisioning lock (limits + insert are atomic across replicas). */
async function locked<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('begin');
    await tx.query('select pg_advisory_xact_lock(727276)');
    const out = await fn(tx);
    await tx.query('commit');
    return out;
  } catch (e) {
    await tx.query('rollback').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

export function provisioningApi(api: Hono<any>) {
  const isAdmin = (c: any) => c.get('user').role === 'admin';
  const bad = (c: any, status: number, error: string) => c.json({ error }, status);
  const body = async <T extends z.ZodType>(c: any, schema: T): Promise<z.infer<T> | Response> => {
    const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return bad(c, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    return parsed.data;
  };
  const view = (r: any) => {
    // only the shape of a hosted server's spec; secret env values never leave the database (sealed)
    if (r.kind === 'hosted') r.spec = { image: r.spec.image, port: r.spec.port, path: r.spec.path, egress: r.spec.egress, env: r.spec.env, secretEnvNames: r.spec.secretEnvNames ?? [] };
    else r.spec = undefined;
    return r;
  };
  const idOf = (c: any) => { const v = c.req.param('id') ?? ''; return /^[1-9]\d{0,15}$/.test(v) ? Number(v) : 0; };
  const off = (c: any) => (config.provisioning ? null : bad(c, 503, 'provisioning is not enabled on this installation'));

  // ---- stores: everyone sees the team's stores; owners (and admins) manage theirs ----
  api.get('/stores', async (c) => c.json((await q(`select ${COLS} ${FROM} where p.kind = 'store' order by p.id`)).map(view)));
  api.post('/stores', async (c) => {
    const o = off(c); if (o) return o;
    const b = await body(c, z.object({ name: displayName, slug, timeoutS: z.number().int().min(20).max(3600).optional() }));
    if (b instanceof Response) return b;
    const u = c.get('user');
    if (b.timeoutS !== undefined && u.role !== 'admin') return bad(c, 403, 'only admins can set a provisioning timeout');
    // safe to retry: the same request from the same owner returns the store it already created
    const same = await one(`select ${COLS} ${FROM} where p.kind = 'store' and p.slug = $1`, [b.slug]);
    if (same && same.ownerId === u.id && same.status !== 'deleting') return c.json(view(same), 200);
    // limits and the insert under one lock: two parallel requests can't both squeeze past "at most N"
    const r = await locked(async (tx) => {
      if (await slugTaken(b.slug, tx)) return `"${b.slug}" is taken (by a store, hosted server or registered upstream)`;
      const mine = (await tx.query(`select count(*)::int as n from provisions where kind = 'store' and owner_id = $1`, [u.id])).rows[0].n;
      if (mine >= config.maxStoresPerUser) return `at most ${config.maxStoresPerUser} stores per user: delete one first`;
      const all = (await tx.query(`select count(*)::int as n from provisions where kind = 'store'`)).rows[0].n;
      if (all >= config.maxStores) return `this installation is at its limit of ${config.maxStores} stores`;
      return (await tx.query(`insert into provisions(kind, slug, name, owner_id, owner_email, status, step, namespace, url, timeout_s)
        values ('store', $1, $2, $3, $4, 'provisioning', 'queued', $5, $6, $7) returning id::int as id`,
        [b.slug, b.name, u.id, u.email, `store-${b.slug}`, config.storeUrlPattern.replace('{slug}', b.slug), b.timeoutS ?? config.storeTimeoutS])).rows[0] as { id: number };
    });
    if (typeof r === 'string') return bad(c, 409, r);
    await wake(r.id);
    return c.json(view(await one(`select ${COLS} ${FROM} where p.id = $1`, [r.id])), 201);
  });

  // ---- hosted MCP servers: admins only ----
  api.get('/hosted', async (c) => {
    if (!isAdmin(c)) return bad(c, 403, 'admin only');
    return c.json((await q(`select ${COLS} ${FROM} where p.kind = 'hosted' order by p.id`)).map(view));
  });
  api.post('/hosted', async (c) => {
    const o = off(c); if (o) return o;
    if (!isAdmin(c)) return bad(c, 403, 'admin only');
    const b = await body(c, z.object({
      name: displayName, slug, image,
      port: z.number().int().min(1024).max(65535), path: z.string().regex(/^\/[A-Za-z0-9._~\/-]{0,100}$/).default('/mcp'),
      env: envMap.default({}), secretEnv: envMap.default({}), egress: z.enum(['none', 'internet']).default('none'),
      timeoutS: z.number().int().min(20).max(3600).optional(),
    }));
    if (b instanceof Response) return b;
    if (config.hostedImagePrefixes.length && !config.hostedImagePrefixes.some((p) => b.image.startsWith(p)))
      return bad(c, 400, `images must come from: ${config.hostedImagePrefixes.join(', ')}`);
    const clash = Object.keys(b.env).find((k) => k in b.secretEnv);
    if (clash) return bad(c, 400, `${clash} is both a plain and a secret variable`);
    const u = c.get('user');
    const spec = { image: b.image, port: b.port, path: b.path, env: b.env, egress: b.egress, secretEnvNames: Object.keys(b.secretEnv) };
    const r = await locked(async (tx) => {
      if (await slugTaken(b.slug, tx)) return `"${b.slug}" is taken`;
      const n = (await tx.query(`select count(*)::int as n from provisions where kind = 'hosted'`)).rows[0].n;
      if (n >= config.maxHosted) return `at most ${config.maxHosted} hosted servers`;
      return (await tx.query(`insert into provisions(kind, slug, name, owner_id, owner_email, spec, secret, status, step, namespace, timeout_s)
        values ('hosted', $1, $2, $3, $4, $5, $6, 'provisioning', 'queued', $7, $8) returning id::int as id`,
        [b.slug, b.name, u.id, u.email, JSON.stringify(spec), seal(Object.keys(b.secretEnv).length ? JSON.stringify(b.secretEnv) : null),
          `mcp-${b.slug}`, b.timeoutS ?? config.hostedTimeoutS])).rows[0] as { id: number };
    });
    if (typeof r === 'string') return bad(c, 409, r);
    await wake(r.id);
    return c.json(view(await one(`select ${COLS} ${FROM} where p.id = $1`, [r.id])), 201);
  });

  // ---- shared: retry a failed one, delete (owner or admin; hosted: admin) ----
  const mayManage = async (c: any) => {
    const r = await one(`select ${COLS} ${FROM} where p.id = $1`, [idOf(c)]);
    if (!r) return { err: bad(c, 404, 'not found') };
    const u = c.get('user');
    if (u.role !== 'admin' && (r.kind === 'hosted' || r.ownerId !== u.id)) return { err: bad(c, 403, r.kind === 'hosted' ? 'admin only' : 'only the owner or an admin can do that') };
    return { r };
  };
  for (const base of ['/stores', '/hosted']) {
    api.post(`${base}/:id/retry`, async (c) => {
      const o = off(c); if (o) return o;
      const { r, err } = await mayManage(c);
      if (err) return err;
      if (r.status !== 'failed') return bad(c, 409, `only a failed one can be retried (it is ${r.status})`);
      // admins may give the retry a different timeout (e.g. after a too-short one)
      const t = Number((await c.req.json().catch(() => ({})))?.timeoutS);
      const timeoutS = isAdmin(c) && Number.isInteger(t) && t >= 20 && t <= 3600 ? t : r.timeoutS;
      await q(`update provisions set status = 'provisioning', step = 'queued', reason = null, timeout_s = $2, started_at = now(), updated_at = now() where id = $1 and status = 'failed'`, [r.id, timeoutS]);
      await wake(r.id);
      return c.json(view(await one(`select ${COLS} ${FROM} where p.id = $1`, [r.id])));
    });
    api.delete(`${base}/:id`, async (c) => {
      const o = off(c); if (o) return o;
      const { r, err } = await mayManage(c);
      if (err) return err;
      await q(`update provisions set status = 'deleting', step = 'queued', reason = null, started_at = now(), updated_at = now() where id = $1`, [r.id]);
      await wake(r.id);
      return c.body(null, 202);
    });
  }
}
