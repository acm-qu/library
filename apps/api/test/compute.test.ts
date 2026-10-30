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
