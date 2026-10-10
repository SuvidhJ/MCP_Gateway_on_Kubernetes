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
];

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
