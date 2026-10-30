import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pacer, setAllocFile, WORKER_IO_BPS, workerBps } from '../src/lib/pace.ts';

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

describe('live worker allocation', () => {
  it('uses the API allocation while it is fresh, and the fixed 8 MiB/s when missing or stale', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'alloc-')), 'io-alloc.json');
    const now = Date.now();
    setAllocFile(file);
    expect(workerBps(now)).toBe(WORKER_IO_BPS); // no file yet
    writeFileSync(file, JSON.stringify({ workerBps: 13 * 2 ** 20, at: now }));
    expect(workerBps(now)).toBe(WORKER_IO_BPS); // cached for a second
    expect(workerBps(now + 1000)).toBe(13 * 2 ** 20);
    expect(workerBps(now + 11_000)).toBe(WORKER_IO_BPS); // the API stopped allocating 10 s ago
    writeFileSync(file, '{"workerBps": 13');
    expect(workerBps(now + 12_000)).toBe(WORKER_IO_BPS); // half-written
    setAllocFile(null);
  });

  it('picks the encode readrate from the allocation, never above the 5 MiB/s source cap', async () => {
    const { sourceReadrate } = await import('../src/lib/ffmpeg.ts');
    expect(sourceReadrate(100 * 2 ** 20, 10, 2.5 * 2 ** 20)).toBeCloseTo(0.25);
    expect(sourceReadrate(100 * 2 ** 20, 10, 20 * 2 ** 20)).toBeCloseTo(0.5);
  });
});

describe('source readrate', () => {
  it('keeps the encode reading the source at or under 5 MiB/s', async () => {
    const { sourceReadrate } = await import('../src/lib/ffmpeg.ts');
    expect(sourceReadrate(100 * 2 ** 20, 10)).toBeCloseTo(0.5); // 10 MiB/s source → 0.5× real time
    expect(sourceReadrate(10 * 2 ** 20, 60)).toBe(2.5); // low bitrate: capped at 2.5× so HLS writes stay ≈ 3 MB/s
    expect(sourceReadrate(2 ** 30, 1)).toBe(0.05); // absurd bitrate: floor so it still finishes
    expect(sourceReadrate(0, 0)).toBe(1);
  });
});
