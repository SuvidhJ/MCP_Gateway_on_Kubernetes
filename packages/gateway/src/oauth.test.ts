import { expect, test } from 'vitest';
import { isCimdId, redirectAllowed, redirectMatches } from './oauth.js';

test('redirect URIs: https, loopback http, app schemes; nothing a browser would execute', () => {
  for (const ok of ['https://app.example/cb', 'http://127.0.0.1:3000/cb', 'http://localhost/callback', 'http://[::1]:9/x', 'cursor://anysphere.cursor-mcp/oauth/callback', 'com.example.app:/oauth'])
    expect(redirectAllowed(ok), ok).toBe(true);
  for (const bad of ['http://evil.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://a.example/cb#x', 'not a url', 'http://localhost.evil.example/cb'])
    expect(redirectAllowed(bad), bad).toBe(false);
});

test('loopback redirects match on any port (RFC 8252 §7.3); everything else exactly', () => {
  const reg = ['http://localhost/callback', 'https://app.example/cb'];
  expect(redirectMatches(reg, 'http://localhost:41234/callback')).toBe(true);
  expect(redirectMatches(reg, 'http://localhost:41234/other')).toBe(false);
  expect(redirectMatches(reg, 'https://app.example/cb')).toBe(true);
  expect(redirectMatches(reg, 'https://app.example:444/cb')).toBe(false);
  expect(redirectMatches(reg, 'https://app.example/cb?x=1')).toBe(false);
  expect(redirectMatches(['http://127.0.0.1/cb'], 'http://localhost:5/cb')).toBe(false);
});

test('client metadata document ids are https URLs with a path', () => {
  expect(isCimdId('https://claude.ai/oauth/claude-code-client-metadata')).toBe(true);
  expect(isCimdId('https://claude.ai/')).toBe(false);
  expect(isCimdId('http://claude.ai/x')).toBe(false);
  expect(isCimdId('dcr_abc')).toBe(false);
});
