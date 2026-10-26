// Code shared by the gateway and the provisioner.
import crypto from 'node:crypto';

/** Upstream credentials at rest: AES-256-GCM with a key derived from a Secret value. Format: v1.<iv>.<tag>.<ct>
 *  (base64url). Values without the prefix are legacy plaintext. `unseal` throws if the value can't be decrypted. */
export function makeSealer(secret: string) {
  const key = crypto.createHash('sha256').update(secret).digest();
  return {
    seal(plain: string | null | undefined): string | null {
      if (!plain) return null;
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
    },
    unseal(stored: string | null | undefined): string | null {
      if (!stored) return null;
      if (!stored.startsWith('v1.')) return stored;
      const [, iv, tag, ct] = stored.split('.');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

/** Upstream slugs (also store and hosted-server names): what becomes the `slug__` tool prefix. */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
/** Slugs nothing may register under (the gateway's meta-tools; the chart's own hostnames). */
export const RESERVED_SLUGS = ['gateway', 'store', 'www', 'api', 'admin', 'mcp', 'oauth'];

/** Kubernetes labels the provisioner puts on (and requires of) every namespace it manages. */
export const MANAGED_LABEL = 'urumi.ai/managed-by';
export const MANAGED_VALUE = 'urumi-provisioner';
