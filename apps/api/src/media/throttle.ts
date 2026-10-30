// The account's disk IO is capped at 30 MB/s for every site together. The library keeps under a 21 MiB/s line (70%),
// shared by four classes in priority order: playback and downloads of large media, uploads (all tus PATCH bodies),
// the worker (hash/seal pacer and the encode's -readrate, told through io-alloc.json) and small files (thumbs,
// posters, views). Under contention each class is guaranteed its share; whatever an idle or light class leaves is
// lent by priority (see allocate). A response is classed by its whole file, so Range slices of a big file are playback.
import { rename, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { type IoSplit, ioSince } from '../lib/compute.ts';
import { HttpError } from '../lib/errors.ts';

const MiB = 2 ** 20;
/** 70% of the account's 30 MB/s: the library's line, so the other sites always keep 30%. */
export const LINE_BPS = 21 * MiB;
/** Highest priority first. */
export const IO_CLASSES = ['playback', 'upload', 'worker', 'small'] as const;
export type IoClass = (typeof IO_CLASSES)[number];
type Rates = Record<IoClass, number>;
/** Each class's guaranteed share when everything is busy at once; they sum to the line. */
export const SHARES: Rates = { playback: 5 * MiB, upload: 5 * MiB, worker: 8 * MiB, small: 3 * MiB };
/** Even if other sites take the whole line, the library keeps moving at this much in total. */
const MIN_POOL_BPS = MiB;
/** Worker processes doing less disk IO than this count as idle. */
const WORKER_ACTIVE_BPS = 64 * 1024;
export const PACE_OVER = MiB;
/** Each held (paced) large response keeps an entry process busy; the account allows 150. */
export const MAX_PACED = 32;

/**
 * Splits `available` bytes/s: every class first gets min(demand, share); the rest is lent in priority order, each
 * up to its remaining demand (Infinity = wants all it can get). If the guarantees alone don't fit (other sites eat
 * into the line past the unused shares), they shrink proportionally.
 */
export function allocate(available: number, demand: Rates, shares: Rates = SHARES): Rates {
  const out = { ...shares };
  let used = 0;
  for (const c of IO_CLASSES) used += out[c] = Math.min(demand[c], shares[c]);
  if (used > available) {
    for (const c of IO_CLASSES) out[c] = (out[c] * available) / used;
    return out;
  }
  let left = available - used;
  for (const c of IO_CLASSES) {
    const more = Math.min(left, demand[c] - out[c]);
    out[c] += more;
    left -= more;
  }
  return out;
}

/** A shared byte budget: awaiting `take(n)` keeps every caller together under `bps` (a number, or read per take). */
export function budget(bps: number | (() => number)) {
  let freeAt = 0; // when the budget has room again (ms)
  return async (bytes: number) => {
    const now = Date.now();
    const start = Math.max(now, freeAt);
    freeAt = start + (bytes / (typeof bps === 'function' ? bps() : bps)) * 1000;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  };
}

type ApiClass = Exclude<IoClass, 'worker'>;
const API_CLASSES: ApiClass[] = ['playback', 'upload', 'small'];
/** Live rates. A class that has been idle starts at its (scaled) share, so it never waits for the next tick. */
let rates: Rates = { ...SHARES };
const asked: Record<ApiClass, number> = { playback: 0, upload: 0, small: 0 }; // bytes requested since the last tick
const waiting: Record<ApiClass, number> = { playback: 0, upload: 0, small: 0 }; // takes held by their budget right now
export const ioRates = (): Rates => ({ ...rates });

/**
 * One allocator pass. Demand: a class with takes held by its budget wants all it can get; otherwise what it asked
 * for since the last pass. The worker wants all it can get while its processes do disk IO. Other sites' IO
 * (account − this process − worker) comes off the line. Each class runs at its allocation, but never below its
 * (scaled) guaranteed share, so a light class can always burst to its share; borrowed capacity comes back within a tick.
 */
export function rebalance(secs: number, io: IoSplit | null) {
  const demand = { worker: io && io.worker > WORKER_ACTIVE_BPS ? Infinity : 0 } as Rates;
  const used = { worker: io?.worker ?? 0 } as Rates;
  for (const c of API_CLASSES) {
    demand[c] = waiting[c] > 0 ? Infinity : asked[c] / secs;
    used[c] = asked[c] / secs;
    asked[c] = 0;
  }
  const others = io ? Math.max(0, io.account - io.self - io.worker) : 0;
  const available = Math.max(MIN_POOL_BPS, LINE_BPS - others);
  const alloc = allocate(available, demand);
  const scale = Math.min(1, available / LINE_BPS);
  rates = Object.fromEntries(IO_CLASSES.map((c) => [c, Math.max(alloc[c], SHARES[c] * scale)])) as Rates;
  last = { at: Date.now(), others, available, used, rates: { ...rates } };
  return rates;
}

let last: { at: number; others: number; available: number; used: Rates; rates: Rates } | null = null;

/** The pool as of the allocator's last pass, for Admin › Processing; `active` is false once it has gone quiet. */
export function poolSnapshot() {
  const active = !!last && Date.now() - last.at < 5000;
  return {
    active,
    lineBps: LINE_BPS,
    othersBps: active ? Math.round(last!.others) : 0,
    classes: IO_CLASSES.map((c) => ({
      id: c,
      shareBps: SHARES[c],
      allocBps: Math.round(active ? last!.rates[c] : SHARES[c]),
      usedBps: Math.round(active ? last!.used[c] : 0),
    })),
  };
}

let allocFile: string | null = null;
/** Where the worker reads its allocation (MEDIA_ROOT/io-alloc.json); set once at startup. */
export const setAllocFile = (file: string) => void (allocFile = file);
let written = { bps: 0, at: 0 };

/** Atomic rewrite when the worker's rate changes, and every 5 s anyway so the worker knows the API is still allocating. */
async function tellWorker() {
  const bps = Math.round(rates.worker);
  if (!allocFile || (bps === written.bps && Date.now() - written.at < 5000)) return;
  written = { bps, at: Date.now() };
  const tmp = `${allocFile}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ workerBps: bps, at: written.at }))
    .then(() => rename(tmp, allocFile!))
    .catch(() => {});
}

let sampler: NodeJS.Timeout | null = null;
let idleTicks = 0;

/** Runs the allocator once a second while the API moves bytes; stops after 10 quiet seconds (the worker then falls back to its fixed rate). */
function watch() {
  if (sampler) return;
  let busy = false;
  let last = Date.now();
  sampler = setInterval(() => {
    if (busy) return;
    busy = true;
    void ioSince()
      .then((io) => {
        const now = Date.now();
        const active = API_CLASSES.some((c) => asked[c] > 0 || waiting[c] > 0);
        rebalance(Math.max(0.5, (now - last) / 1000), io);
        last = now;
        idleTicks = active ? 0 : idleTicks + 1;
        if (idleTicks >= 10 && sampler) {
          clearInterval(sampler);
          sampler = null;
          idleTicks = 0;
          rates = { ...SHARES };
          return;
        }
        return tellWorker();
      })
      .finally(() => (busy = false));
  }, 1000);
  sampler.unref();
}

function pool(c: ApiClass) {
  const take = budget(() => rates[c]);
  return async (bytes: number) => {
    watch();
    asked[c] += bytes;
    waiting[c]++;
    try {
      await take(bytes);
    } finally {
      waiting[c]--;
    }
  };
}

export const takeUpload = pool('upload');
const takeLarge = pool('playback');
const takeSmall = pool('small');

export async function* paced(src: AsyncIterable<Buffer>, take: (bytes: number) => Promise<void>) {
  for await (const chunk of src) {
    await take(chunk.length);
    yield chunk;
  }
}

let held = 0;

/** Throws 429 when MAX_PACED large responses are open; call before setting any response header. */
export function admit(fileSize: number) {
  if (fileSize > PACE_OVER && held >= MAX_PACED) throw new HttpError('rate_limited', { retry_after: 5 });
}

/** The response body for a file of `fileSize` bytes, paced through its budget (one chunk buffered, not 16). */
export function servedAs(src: Readable, fileSize: number) {
  const large = fileSize > PACE_OVER;
  const out = Readable.from(paced(src, large ? takeLarge : takeSmall), { highWaterMark: 1 });
  if (large) {
    held++;
    out.once('close', () => held--);
  }
  return out;
}
