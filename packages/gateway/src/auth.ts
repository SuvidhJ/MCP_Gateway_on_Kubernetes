// Identity: scrypt passwords, server-side sessions (cookie + CSRF token), API keys stored as HMAC-SHA256 with a
// pepper, and short-lived delegated JWTs for the chat agent (sub = user, act = chat-agent).
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { one, q } from './db.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'admin' | 'member';
export interface User { id: number; email: string; name: string; role: Role; disabled: boolean }
/** Who is calling an MCP tool. `via` is what the audit log shows ("key:laptop" or "chat"). */
export interface Principal { userId: number; email: string; role: Role; via: string; keyId?: number }

export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [alg, salt, h] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), 32);
  const want = Buffer.from(h, 'base64url');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export const randomPassword = () => crypto.randomBytes(12).toString('base64url');

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const userCols = 'u.id::int as id, u.email, u.name, u.role, u.disabled';

// ---- sessions ----
export async function createSession(userId: number) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  await q(`insert into sessions(id, user_id, csrf, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))`,
    [sha256(token), userId, csrf, config.sessionHours]);
  return { token, csrf };
}
export async function sessionUser(token: string | undefined) {
  if (!token) return undefined;
  return one<User & { csrf: string; sid: string }>(
    `select ${userCols}, s.csrf, s.id as sid from sessions s join users u on u.id = s.user_id
     where s.id = $1 and s.expires_at > now() and not u.disabled`, [sha256(token)]);
}
export const deleteSession = (token: string) => q('delete from sessions where id = $1', [sha256(token)]);

// ---- API keys ----
const keyHash = (secret: string) => crypto.createHmac('sha256', config.keyPepper).update(secret).digest('hex');
export async function createKey(userId: number, name: string) {
  const secret = `urumi_${crypto.randomBytes(24).toString('base64url')}`;
  const row = await one(`insert into api_keys(user_id, name, prefix, hash) values ($1, $2, $3, $4) returning id::int as id`,
    [userId, name, secret.slice(0, 12), keyHash(secret)]);
  return { id: row!.id as number, secret };
}
export async function principalFromKey(secret: string): Promise<Principal | undefined> {
  const r = await one(`select k.id::int as key_id, k.name as key_name, ${userCols} from api_keys k join users u on u.id = k.user_id
     where k.hash = $1 and k.revoked_at is null and not u.disabled`, [keyHash(secret)]);
  if (!r) return undefined;
  // last_used_at at most once a minute per key (cheap, but avoids a write per call)
  q(`update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [r.key_id]).catch(() => {});
  return { userId: r.id, email: r.email, role: r.role, via: `key:${r.key_name}`, keyId: r.key_id };
}

// ---- delegated tokens for the chat agent ----
const jwtKey = new TextEncoder().encode(config.jwtSecret);
const AUD = 'urumi-gateway-mcp';
export const mintDelegatedToken = (user: User) =>
  new SignJWT({ act: { sub: 'chat-agent' } })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setAudience(AUD)
    .setIssuer(config.publicUrl)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(jwtKey);
export async function principalFromJwt(token: string): Promise<Principal | undefined> {
  try {
    const { payload } = await jwtVerify(token, jwtKey, { audience: AUD, issuer: config.publicUrl, algorithms: ['HS256'] });
    const u = await one<User>(`select ${userCols} from users u where u.id = $1 and not u.disabled`, [Number(payload.sub)]);
    if (!u) return undefined;
    const act = (payload.act as { sub?: string } | undefined)?.sub ?? 'agent';
    return { userId: u.id, email: u.email, role: u.role, via: act === 'chat-agent' ? 'chat' : act };
  } catch {
    return undefined;
  }
}

// ---- first admin ----
export async function ensureAdmin() {
  const n = await one<{ n: number }>('select count(*)::int as n from users');
  if (n && n.n > 0) return;
  await q(`insert into users(email, name, role, password_hash) values ($1, 'Admin', 'admin', $2) on conflict (email) do nothing`,
    [config.adminEmail.toLowerCase(), await hashPassword(config.adminPassword)]);
}
