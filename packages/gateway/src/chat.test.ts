import { describe, expect, it } from 'vitest';
import { fallbackModel, startOfDay } from './chat.js';

describe('startOfDay', () => {
  it('uses the store timezone date and offset', () => {
    // 23:28 UTC on Oct 10 is already Oct 11 in Kolkata
    expect(startOfDay('Asia/Kolkata', new Date('2026-10-10T23:28:00Z'))).toBe('2026-10-11T00:00:00+05:30');
    expect(startOfDay('UTC', new Date('2026-10-10T23:28:00Z'))).toBe('2026-10-10T00:00:00+00:00');
    expect(startOfDay('America/New_York', new Date('2026-10-11T02:00:00Z'))).toBe('2026-10-10T00:00:00-04:00');
  });
});

// fake provider models: 'ok' streams text, 'fail' rejects like a 503, 'hang' never answers, 'silent' sends headers
// (stream-start) and then nothing, 'errpart' streams an error part first
const fake = (modelId: string) => ({
  specificationVersion: 'v4', provider: 'llm', modelId, supportedUrls: {},
  doGenerate: async () => { throw new Error('unused'); },
  doStream: ({ abortSignal }: { abortSignal?: AbortSignal }) => {
    if (modelId === 'fail') return Promise.reject(new Error('503 high demand'));
    if (modelId === 'hang') return new Promise((_, reject) => abortSignal?.addEventListener('abort', () => reject(abortSignal.reason)));
    const parts = modelId === 'silent' ? [{ type: 'stream-start' }]
      : modelId === 'errpart' ? [{ type: 'stream-start' }, { type: 'error', error: new Error('bad') }]
      : [{ type: 'stream-start' }, { type: 'text-delta', delta: `from ${modelId}` }, { type: 'finish' }];
    return Promise.resolve({ stream: new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); if (modelId !== 'silent') c.close(); } }) });
  },
}) as any;
const run = async (ids: string[], options: { abortSignal?: AbortSignal } = {}) => {
  const r = await fallbackModel(ids.map(fake), 200).doStream(options as any);
  const out: any[] = [];
  for await (const p of r.stream as any) out.push(p);
  return out;
};

describe('fallbackModel', () => {
  it('uses the first model that answers, keeping every part', async () => {
    expect(await run(['ok'])).toEqual([{ type: 'stream-start' }, { type: 'text-delta', delta: 'from ok' }, { type: 'finish' }]);
    expect((await run(['fail', 'hang', 'silent', 'errpart', 'second']))[1]).toEqual({ type: 'text-delta', delta: 'from second' });
  });
  it('surfaces the last error when every model fails', async () => {
    await expect(run(['fail', 'hang'])).rejects.toThrow(/hang sent nothing/);
  });
  it('does not fall back after the user aborts', async () => {
    const ac = new AbortController();
    const p = run(['hang', 'ok'], { abortSignal: ac.signal });
    ac.abort(new Error('user stopped'));
    await expect(p).rejects.toThrow(/user stopped/);
  });
});
