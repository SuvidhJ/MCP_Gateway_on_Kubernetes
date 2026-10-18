// Postgres access + schema migrations. Migrations run at start under pg_advisory_lock, so several gateway replicas
// starting together apply each migration exactly once.
import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => log.error({ err: e.message }, 'pg pool error'));

export const q = async <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows;
export const one = async <T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) =>
  (await pool.query<T>(text, params)).rows[0] as T | undefined;

const MIGRATIONS: string[] = [
  `create table users (
     id bigserial primary key,
     email text not null unique,
     name text not null default '',
     role text not null check (role in ('admin','member')),
     password_hash text not null,
     disabled boolean not null default false,
     created_at timestamptz not null default now());
   create table sessions (
     id text primary key,              -- sha256 of the cookie value
     user_id bigint not null references users(id) on delete cascade,
     csrf text not null,
     expires_at timestamptz not null,
     created_at timestamptz not null default now());
   create table api_keys (
     id bigserial primary key,
     user_id bigint not null references users(id) on delete cascade,
     name text not null,
     prefix text not null,             -- first chars of the secret, for display
     hash text not null unique,        -- HMAC-SHA256(pepper, secret)
     created_at timestamptz not null default now(),
     last_used_at timestamptz,
     revoked_at timestamptz);
   create table upstreams (
     id bigserial primary key,
     slug text not null unique,
     name text not null,
     url text not null,
     auth_header text,
     credential text,
     enabled boolean not null default true,
     timeout_ms integer,
     created_by bigint references users(id) on delete set null,
     created_at timestamptz not null default now());
   create table upstream_events (
     id bigserial primary key,
     upstream_id bigint not null references upstreams(id) on delete cascade,
     at timestamptz not null default now(),
     status text not null,
     error text);
   create table audit_log (
     id bigserial primary key,
     at timestamptz not null default now(),
     user_id bigint references users(id) on delete set null,
     user_email text not null,
     via text not null,
     server text,
     tool text not null,
     duration_ms integer not null,
     outcome text not null,
     error text,
     era text,
     client text);
   create index audit_log_user on audit_log (user_id, id desc);
   create index upstream_events_up on upstream_events (upstream_id, id desc);`,
  // S-2 tool permissions: per-tool access level; no row = everyone (member and admin).
  `create table tool_policies (
     upstream_id bigint not null references upstreams(id) on delete cascade,
     tool text not null,
     access text not null check (access in ('member','admin','off')),
     primary key (upstream_id, tool));`,
  // Tool-definition pinning (rug-pull defence): the definition seen first (or last approved by an admin).
  `create table tool_pins (
     upstream_id bigint not null references upstreams(id) on delete cascade,
     tool text not null,
     hash text not null,
     description text,
     approved_at timestamptz not null default now(),
     primary key (upstream_id, tool));`,
  // Token buckets shared by every replica (MCP requests per key, chat turns, failed logins); password lifecycle.
  `create table rate_buckets (
     key text primary key,
     tokens double precision not null,
     ok boolean not null default true,
     at timestamptz not null default now());
   alter table users add column must_change_password boolean not null default false;
   create index audit_log_at on audit_log (at);
   create index sessions_expires on sessions (expires_at);`,
  // OAuth (oauth.ts): registered clients, one grant per consent, single-use codes, hashed access/refresh tokens.
  `create table oauth_clients (
    client_id text primary key,             -- 'dcr_…' or the https URL of a client metadata document
    kind text not null check (kind in ('dcr', 'cimd')),
    client_name text not null,
    redirect_uris text[] not null,
    client_uri text,
    fetched_at timestamptz,                 -- CIMD: when the document was last fetched
    expires_at timestamptz,                 -- CIMD: cache lifetime from the document's Cache-Control
    created_at timestamptz not null default now());
  create table oauth_grants (
    id bigserial primary key,
    user_id bigint not null references users(id) on delete cascade,
    client_id text not null,
    client_name text not null,
    redirect_host text not null,
    resource text not null,
    scope text not null,
    created_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz);
  create table oauth_codes (
    hash text primary key,
    client_id text not null,
    user_id bigint not null references users(id) on delete cascade,
    redirect_uri text not null,
    code_challenge text not null,
    resource text not null,
    scope text not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    grant_id bigint references oauth_grants(id) on delete cascade);
  create table oauth_tokens (
    hash text primary key,
    grant_id bigint not null references oauth_grants(id) on delete cascade,
    kind text not null check (kind in ('access', 'refresh')),
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now());
  create index oauth_grants_user on oauth_grants (user_id);
  create index oauth_tokens_grant on oauth_tokens (grant_id);`,
];

// Provisioning (stores, hosted MCP servers): the gateway writes the desired state, the provisioner reconciles it
// in Kubernetes and records progress here; managed upstreams are registered by the provisioner.
MIGRATIONS.push(`
  alter table upstreams add column managed_by text;   -- 'provision:<id>': created by the provisioner, URL fixed
  create table provisions (
    id bigserial primary key,
    kind text not null check (kind in ('store', 'hosted')),
    slug text not null unique,                       -- also the upstream slug: tools are <slug>__<tool>
    name text not null,
    owner_id bigint references users(id) on delete set null,
    owner_email text not null,
    spec jsonb not null default '{}',                -- hosted: image, port, path, env, egress
    secret text,                                     -- hosted: sealed JSON of secret env vars
    status text not null check (status in ('provisioning', 'ready', 'failed', 'deleting')),
    step text,                                       -- what the provisioner is doing / last did
    reason text,                                     -- why it failed
    namespace text not null unique,
    url text,                                        -- store: public storefront URL
    timeout_s integer not null,
    attempts integer not null default 0,
    created_at timestamptz not null default now(),
    started_at timestamptz not null default now(),   -- this attempt (retry resets it)
    ready_at timestamptz,
    updated_at timestamptz not null default now());
  create index provisions_owner on provisions (owner_id);`);

/** Take one token from a shared bucket (`burst` capacity, refilled at `perMin`). Returns 0 if allowed, else the
 *  seconds to wait. One atomic upsert, so concurrent requests on several replicas can't overspend. */
export async function rateTake(key: string, burst: number, perMin: number): Promise<number> {
  const r = await one<{ tokens: number; ok: boolean }>(
    `insert into rate_buckets as b (key, tokens, ok, at) values ($1, $2::float8 - 1, true, now())
     on conflict (key) do update set
       ok = least($2::float8, b.tokens + extract(epoch from now() - b.at) * $3::float8 / 60) >= 1,
       tokens = least($2::float8, b.tokens + extract(epoch from now() - b.at) * $3::float8 / 60)
                - case when least($2::float8, b.tokens + extract(epoch from now() - b.at) * $3::float8 / 60) >= 1 then 1 else 0 end,
       at = now()
     returning tokens, ok`, [key, burst, perMin]);
  if (!r || r.ok) return 0;
  return Math.max(1, Math.ceil(((1 - r.tokens) / perMin) * 60));
}

/** Seconds until a bucket has a token again, without taking one (0 = available). */
export async function ratePeek(key: string, burst: number, perMin: number): Promise<number> {
  const r = await one<{ t: number }>(`select least($2::float8, tokens + extract(epoch from now() - at) * $3::float8 / 60) as t
                                       from rate_buckets where key = $1`, [key, burst, perMin]);
  if (!r || r.t >= 1) return 0;
  return Math.max(1, Math.ceil(((1 - r.t) / perMin) * 60));
}

/** Housekeeping, run by one replica at a time: expired sessions and buckets, and audit/status history past retention. */
export async function maintenance(auditDays: number, eventDays: number) {
  const c = await pool.connect();
  try {
    const { rows } = await c.query('select pg_try_advisory_lock(727275) as got');
    if (!rows[0].got) return;
    try {
      await c.query('delete from sessions where expires_at < now()');
      await c.query(`delete from rate_buckets where at < now() - interval '1 day'`);
      if (auditDays > 0) await c.query(`delete from audit_log where at < now() - make_interval(days => $1)`, [auditDays]);
      if (eventDays > 0) await c.query(`delete from upstream_events where at < now() - make_interval(days => $1)`, [eventDays]);
      for (const sql of extraMaintenance) await c.query(sql);
    } finally {
      await c.query('select pg_advisory_unlock(727275)');
    }
  } finally {
    c.release();
  }
}
/** Other modules (OAuth, provisioning) add their own cleanup statements. */
export const extraMaintenance: string[] = [];

/** Clear a bucket (e.g. failed-login counter after a successful login). */
export const rateReset = (key: string) => q('delete from rate_buckets where key = $1', [key]);

export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(727274)');
    await c.query('create table if not exists schema_migrations (version int primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select version from schema_migrations')).rows.map((r) => r.version));
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (done.has(i + 1)) continue;
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations(version) values ($1)', [i + 1]);
        await c.query('commit');
        log.info({ version: i + 1 }, 'migration applied');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock(727274)').catch(() => {});
    c.release();
  }
}

// Wait for Postgres at start (the pod may start before the database is ready).
export async function waitForDb(maxMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      await pool.query('select 1');
      return;
    } catch (e) {
      if (Date.now() - t0 > maxMs) throw e;
      log.warn({ err: (e as Error).message }, 'waiting for postgres');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
