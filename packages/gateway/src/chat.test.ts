import { describe, expect, it } from 'vitest';
import { startOfDay } from './chat.js';

describe('startOfDay', () => {
  it('uses the store timezone date and offset', () => {
    // 23:28 UTC on Oct 10 is already Oct 11 in Kolkata
    expect(startOfDay('Asia/Kolkata', new Date('2026-10-10T23:28:00Z'))).toBe('2026-10-11T00:00:00+05:30');
    expect(startOfDay('UTC', new Date('2026-10-10T23:28:00Z'))).toBe('2026-10-10T00:00:00+00:00');
    expect(startOfDay('America/New_York', new Date('2026-10-11T02:00:00Z'))).toBe('2026-10-10T00:00:00-04:00');
  });
});
