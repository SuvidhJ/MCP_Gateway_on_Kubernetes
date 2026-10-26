import { expect, test } from 'vitest';
import { redactUrl, safeToolName } from './upstreams.js';

test('tool names become client-safe and unique', () => {
  const taken = new Set<string>();
  const a = safeToolName('files.read', taken); taken.add(a);
  const b = safeToolName('files/read', taken); taken.add(b);
  expect(a).toBe('files_read');
  expect(b).toBe('files_read_2');
  expect(safeToolName('list_orders', new Set())).toBe('list_orders');
  const long = safeToolName('x'.repeat(200), new Set());
  expect(long.length).toBeLessThanOrEqual(64);
  expect(/^[A-Za-z0-9_-]+$/.test(safeToolName('weird name ✓ (v2)', new Set()))).toBe(true);
});

test('redactUrl hides userinfo and query values', () => {
  expect(redactUrl('https://u:p@mcp.example.com/mcp?api_key=SECRET&x=1')).toBe('https://mcp.example.com/mcp?api_key=***&x=***');
  expect(redactUrl('http://woo-mcp/mcp')).toBe('http://woo-mcp/mcp');
  expect(redactUrl('not a url')).toBe('(invalid url)');
});
