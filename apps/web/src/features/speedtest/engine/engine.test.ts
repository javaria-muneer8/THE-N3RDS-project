import { describe, expect, it } from 'vitest';
import { pingStats, runPing } from './ping';

describe('speed-test engine: ping', () => {
  it('drops the warm-up sample, uses the median, computes jitter and loss', () => {
    const r = pingStats([80, 20, 22, null, 24, 20, null, 26]);
    expect(r.sent).toBe(8);
    expect(r.lossPct).toBe(25);
    expect(r.samples).toEqual([20, 22, 24, 20, 26]); // first (warm-up) dropped
    expect(r.pingMs).toBe(22);
    expect(r.jitterMs).toBeCloseTo((2 + 2 + 4 + 6) / 4);
  });
  it('reports total loss when nothing answers (→ "server unreachable")', async () => {
    const failing = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const r = await runPing({ count: 4, gapMs: 1, fetchImpl: failing });
    expect(r.ok).toBe(0);
    expect(r.lossPct).toBe(100);
  });
  it('measures round trips against a mocked server', async () => {
    const ok = (() => new Promise((res) => setTimeout(() => res(new Response(null, { status: 204 })), 5))) as unknown as typeof fetch;
    const r = await runPing({ count: 6, gapMs: 1, fetchImpl: ok });
    expect(r.ok).toBe(5);
    expect(r.pingMs).toBeGreaterThanOrEqual(4);
    expect(r.lossPct).toBe(0);
  });
});
