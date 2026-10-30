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
  const drain = async (r: AsyncIterable<unknown>) => {
    for await (const _ of r) void _;
  };

  it('paces small files through their own budget', async () => {
    const { Readable } = await import('node:stream');
    const { servedAs, SMALL_BPS } = await import('../src/media/throttle.ts');
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(SMALL_BPS / 16)); // the 2nd-4th wait 1/16 s each
    const t0 = Date.now();
    await drain(servedAs(Readable.from(chunks), 1024));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it('paces a small Range slice of a big file by the file, not the slice', async () => {
    const { Readable } = await import('node:stream');
    const { servedAs, SERVE_BPS, PACE_OVER } = await import('../src/media/throttle.ts');
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(SERVE_BPS / 32)); // a 640 KiB slice: the 2nd-4th wait 1/32 s each
    expect(chunks.length * chunks[0]!.length).toBeLessThan(PACE_OVER);
    const t0 = Date.now();
    await drain(servedAs(Readable.from(chunks), 500 * 2 ** 20));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });

  it('answers 429 once MAX_PACED large responses are held, and frees a slot when one closes', async () => {
    const { Readable } = await import('node:stream');
    const { once } = await import('node:events');
    const { admit, servedAs, MAX_PACED } = await import('../src/media/throttle.ts');
    const open = Array.from({ length: MAX_PACED }, () => servedAs(Readable.from([Buffer.alloc(1)]), 100 * 2 ** 20));
    expect(() => admit(100 * 2 ** 20)).toThrow(expect.objectContaining({ code: 'rate_limited', extra: { retry_after: 5 } }));
    expect(() => admit(1024)).not.toThrow(); // small files are never refused
    open[0]!.destroy();
    await once(open[0]!, 'close');
    expect(() => admit(100 * 2 ** 20)).not.toThrow();
    for (const s of open.slice(1)) s.destroy();
  });
});

describe('worker wake', () => {
  it('keeps at most one pending waiter', async () => {
    const { existsSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { wakeWorker } = await import('../src/lib/wake.ts');
    const dir = mkdtempSync(path.join(tmpdir(), 'wake-'));
    wakeWorker('sleep 0.3');
    wakeWorker(`touch ${dir}/skipped`); // the first is still alive
    await new Promise((r) => setTimeout(r, 600));
    wakeWorker(`touch ${dir}/ran`);
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(`${dir}/skipped`)).toBe(false);
    expect(existsSync(`${dir}/ran`)).toBe(true);
  });
});

describe('live upload rate', () => {
  it('gives uploads what the 70% line leaves, between 2 and 21 MiB/s', async () => {
    const { uploadRate, IO_TARGET_BPS, UPLOAD_FLOOR_BPS, UPLOAD_START_BPS } = await import('../src/media/throttle.ts');
    const MiB = 2 ** 20;
    expect(uploadRate(null, 0)).toBe(UPLOAD_START_BPS); // nothing measured yet
    expect(uploadRate(0, 0)).toBe(IO_TARGET_BPS); // a quiet account: uploads get the whole 21
    expect(uploadRate(21 * MiB, 21 * MiB)).toBe(IO_TARGET_BPS); // only uploads are writing: keep the full rate
    expect(uploadRate(13 * MiB, 3 * MiB)).toBe(11 * MiB); // 10 MiB/s of encoding and serving leaves 11
    expect(uploadRate(40 * MiB, 0)).toBe(UPLOAD_FLOOR_BPS); // the account is already busy: the floor
  });
});
