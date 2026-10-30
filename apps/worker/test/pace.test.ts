import { describe, expect, it } from 'vitest';
import { pacer } from '../src/lib/pace.ts';

describe('IO pacer', () => {
  it('holds a full-file read to the given rate', async () => {
    const pace = pacer(10 * 2 ** 20); // 10 MiB/s
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await pace(2 ** 20); // 4 MiB
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380); // ≈ 400 ms at 10 MiB/s
  });

  it('never waits while under the rate', async () => {
    const pace = pacer(1024 * 2 ** 20);
    const t0 = Date.now();
    await pace(2 ** 20);
    expect(Date.now() - t0).toBeLessThan(50);
  });
});

describe('source readrate', () => {
  it('keeps the encode reading the source at or under 8 MiB/s', async () => {
    const { sourceReadrate } = await import('../src/lib/ffmpeg.ts');
    expect(sourceReadrate(100 * 2 ** 20, 10)).toBeCloseTo(0.8); // 10 MiB/s source → 0.8× real time
    expect(sourceReadrate(10 * 2 ** 20, 60)).toBe(20); // low bitrate: capped at 20×
    expect(sourceReadrate(2 ** 30, 1)).toBe(0.25); // absurd bitrate: floor so it still finishes
    expect(sourceReadrate(0, 0)).toBe(1);
  });
});
