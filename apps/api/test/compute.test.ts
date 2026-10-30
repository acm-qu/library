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
    const { servedAs, SHARES } = await import('../src/media/throttle.ts');
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(SHARES.small / 16)); // an idle class starts at its share: each waits 1/16 s
    const t0 = Date.now();
    await drain(servedAs(Readable.from(chunks), 1024));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it('paces a small Range slice of a big file by the file, not the slice', async () => {
    const { Readable } = await import('node:stream');
    const { servedAs, SHARES, PACE_OVER } = await import('../src/media/throttle.ts');
    const chunks = Array.from({ length: 4 }, () => Buffer.alloc(SHARES.playback / 32)); // a 640 KiB slice: each waits 1/32 s
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

describe('disk IO allocator', () => {
  const MiB = 2 ** 20;
  const d = (playback: number, upload: number, worker: number, small: number) => ({ playback: playback * MiB, upload: upload * MiB, worker: worker * MiB, small: small * MiB });

  it('guarantees each busy class its share and lends the rest by priority (playback, uploads, worker, small)', async () => {
    const { allocate, LINE_BPS } = await import('../src/media/throttle.ts');
    const at = (demand: ReturnType<typeof d>, others = 0) => Object.values(allocate(LINE_BPS - others * MiB, demand)).map((v) => Math.round((v / MiB) * 100) / 100);
    expect(at(d(0, 25, 0, 0))).toEqual([0, 21, 0, 0]); // only uploads: the whole line
    expect(at(d(12, 20, 0, 0))).toEqual([12, 9, 0, 0]);
    expect(at(d(12, 20, 10, 0))).toEqual([8, 5, 8, 0]);
    expect(at(d(3, 20, 10, 0))).toEqual([3, 10, 8, 0]);
    expect(at(d(12, 20, 10, 6))).toEqual([5, 5, 8, 3]); // everything saturated: exactly the shares
    expect(at(d(2, 20, 4, 1))).toEqual([2, 14, 4, 1]); // light classes keep what they ask for
    expect(at(d(12, 20, 10, 6), 6)).toEqual([3.57, 3.57, 5.71, 2.14]); // other sites use 6: the shares scale by 15/21
    expect(at(d(1, 20, 0, 0), 6)).toEqual([1, 14, 0, 0]); // ...but only once the lendable pool is gone
    expect(at(d(0, Infinity, 0, 0))).toEqual([0, 21, 0, 0]); // a class held by its budget wants all it can get
  });

  it('gives a large response priority over an upload when both want more than the line', async () => {
    const { Readable } = await import('node:stream');
    const { ioRates, LINE_BPS, paced, servedAs, SHARES, takeUpload } = await import('../src/media/throttle.ts');
    let on = true;
    async function* fast() {
      while (on) yield Buffer.alloc(256 * 1024);
    }
    const drain = async (r: AsyncIterable<unknown>) => {
      let n = 0;
      for await (const c of r) n += (c as Buffer).length;
      return n;
    };
    const big = drain(servedAs(Readable.from(fast()), 500 * MiB));
    const up = drain(paced(fast(), takeUpload));
    await new Promise((r) => setTimeout(r, 2300)); // two allocator passes
    const r = ioRates();
    on = false;
    await Promise.all([big, up]);
    expect(r.upload).toBeGreaterThanOrEqual(SHARES.upload * 0.7);
    expect(r.playback).toBeGreaterThan(r.upload);
    if (process.platform !== 'linux') expect([r.playback, r.upload]).toEqual([LINE_BPS - SHARES.upload, SHARES.upload]); // nothing else measured off Linux
  });
});

describe('pool snapshot', () => {
  it("reports each class's share, live allocation and use after an allocator pass", async () => {
    const { rebalance, poolSnapshot, SHARES, LINE_BPS } = await import('../src/media/throttle.ts');
    const MiB = 2 ** 20;
    rebalance(1, null); // flush demand left over by earlier tests in this file
    rebalance(1, { account: 9 * MiB, self: 0, worker: 6 * MiB }); // the worker busy, other sites using 3
    const p = poolSnapshot();
    expect(p).toMatchObject({ active: true, lineBps: LINE_BPS, othersBps: 3 * MiB });
    const worker = p.classes.find((c) => c.id === 'worker')!;
    expect(worker).toMatchObject({ shareBps: SHARES.worker, usedBps: 6 * MiB });
    expect(worker.allocBps).toBe(18 * MiB); // the only active class borrows everything left under the line
    expect(p.classes.map((c) => c.id)).toEqual(['playback', 'upload', 'worker', 'small']);
  });
});
