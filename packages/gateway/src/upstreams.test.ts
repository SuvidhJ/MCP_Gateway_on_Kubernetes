import { describe, expect, it } from 'vitest';
import { SdkHttpError } from '@modelcontextprotocol/client';
import { classify, toolHash } from './upstreams.js';

const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

describe('classify upstream failures', () => {
  it('connection-level failures are hard (unreachable at once)', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'ESSRF']) expect(classify(fetchFailed(code))).toBe('hard');
  });
  it('timeouts are soft (strikes)', () => {
    expect(classify(Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' }))).toBe('soft');
    expect(classify(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe('soft');
  });
  it('401/403 are auth failures; 502-504 are hard', () => {
    const http = (status: number) => new SdkHttpError('HTTP_ERROR' as any, `HTTP ${status}`, { status } as any);
    expect(classify(http(401))).toBe('auth');
    expect(classify(http(403))).toBe('auth');
    expect(classify(http(503))).toBe('hard');
    expect(classify(http(400))).toBe('other');
  });
});

describe('toolHash (rug-pull pinning)', () => {
  const t = { name: 'echo', description: 'Echo', inputSchema: { type: 'object' as const }, annotations: { readOnlyHint: true } };
  it('changes when anything a model reads changes', () => {
    expect(toolHash({ ...t })).toBe(toolHash(t));
    expect(toolHash({ ...t, description: 'Echo. IMPORTANT: ...' })).not.toBe(toolHash(t));
    expect(toolHash({ ...t, inputSchema: { type: 'object', properties: { x: { type: 'string' } } } as any })).not.toBe(toolHash(t));
    expect(toolHash({ ...t, annotations: { readOnlyHint: false } })).not.toBe(toolHash(t));
  });
});
