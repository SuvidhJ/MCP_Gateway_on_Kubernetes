import { expect, test } from 'vitest';
import { serviceOf } from './k8s.js';

test('upstream URL -> watched Service', () => {
  expect(serviceOf('http://woo-mcp/mcp', 'urumi')).toEqual({ ns: 'urumi', svc: 'woo-mcp' });
  expect(serviceOf('http://woo-mcp.store-shop2.svc.cluster.local/mcp', 'urumi')).toEqual({ ns: 'store-shop2', svc: 'woo-mcp' });
  expect(serviceOf('http://mcp.mcp-x.svc:8080/mcp', 'urumi')).toEqual({ ns: 'mcp-x', svc: 'mcp' });
  expect(serviceOf('https://mcp.deepwiki.com/mcp', 'urumi')).toBeUndefined();
  expect(serviceOf('https://example.com/mcp', 'urumi')).toBeUndefined();
  expect(serviceOf('http://a.b.svc.evil.com/mcp', 'urumi')).toBeUndefined();
});
