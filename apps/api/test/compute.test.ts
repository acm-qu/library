import { describe, expect, it } from 'vitest';
import { computeUsage, HOST_LIMITS, parseIo, parseStat } from '../src/lib/compute.ts';

describe('compute usage', () => {
  it('reads CPU ticks and threads from /proc stat, even when the name has spaces and parentheses', () => {
    const line = '4242 (lsnode:/home/q (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 39 19 11 0 123 456 789';
    expect(parseStat(line)).toEqual({ ticks: 300, threads: 11 });
  });

  it('counts disk bytes, not cached reads', () => {
    expect(parseIo('rchar: 999999\nwchar: 888888\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n')).toBe(12288);
  });

  it('reports usage against the host limits (or unavailable off Linux)', async () => {
    const r = await computeUsage(50);
    expect(r.limits).toEqual(HOST_LIMITS);
    if (process.platform === 'linux') expect(r.threads).toBeGreaterThan(0);
    else expect(r.available).toBe(false);
  });
});

describe('media serving budget', () => {
  it('paces large responses to the shared rate and leaves small ones alone', async () => {
    const { Readable } = await import('node:stream');
    const { servedAs, SERVE_BPS } = await import('../src/media/throttle.ts');
    const small = Readable.from([Buffer.alloc(1024)]);
    expect(servedAs(small, 1024)).toBe(small);
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(SERVE_BPS / 8)); // half a second's worth in total
    const t0 = Date.now();
    for await (const _ of servedAs(Readable.from(chunks), SERVE_BPS / 2)) void _;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });
});
