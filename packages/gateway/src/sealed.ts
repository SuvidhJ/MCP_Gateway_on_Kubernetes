// Upstream credentials at rest: AES-256-GCM with a key from the `gateway-app` Secret (CREDENTIAL_KEY), so a database
// dump or backup alone doesn't reveal them. Format: v1.<iv>.<tag>.<ciphertext> (base64url). Values without the
// prefix are treated as legacy plaintext and re-sealed on the next write.
import crypto from 'node:crypto';
import { config } from './config.js';

const key = crypto.createHash('sha256').update(config.credentialKey).digest(); // 32 bytes from any-length secret

export function seal(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
}

export function unseal(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('v1.')) return stored;
  const [, iv, tag, ct] = stored.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
