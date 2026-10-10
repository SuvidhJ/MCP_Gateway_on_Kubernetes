import { describe, expect, it } from 'vitest';
import { seal, unseal } from './sealed.js';

describe('sealed credentials', () => {
  it('round-trips and never stores the plaintext', () => {
    const s = seal('Bearer secret-token')!;
    expect(s.startsWith('v1.')).toBe(true);
    expect(s).not.toContain('secret-token');
    expect(unseal(s)).toBe('Bearer secret-token');
    expect(seal('Bearer secret-token')).not.toBe(s); // fresh IV each time
  });
  it('passes through empty and legacy plaintext values', () => {
    expect(seal('')).toBeNull();
    expect(unseal(null)).toBeNull();
    expect(unseal('plain')).toBe('plain');
  });
  it('rejects tampered ciphertext', () => {
    const s = seal('x')!;
    expect(() => unseal(s.slice(0, -2) + (s.endsWith('A') ? 'BB' : 'AA'))).toThrow();
  });
});
