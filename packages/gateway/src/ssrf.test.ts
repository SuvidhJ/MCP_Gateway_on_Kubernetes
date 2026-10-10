import { describe, expect, it } from 'vitest';
import { isBlocked } from './ssrf.js';

describe('SSRF block list', () => {
  it.each([
    '127.0.0.1', '10.43.0.10', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe',
  ])('blocks %s', (ip) => expect(isBlocked(ip)).toBe(true));
  it.each(['1.1.1.1', '140.82.112.3', '2606:4700:4700::1111'])('allows public %s', (ip) => expect(isBlocked(ip)).toBe(false));
  it('treats non-IPs as blocked', () => expect(isBlocked('localhost')).toBe(true));
});
