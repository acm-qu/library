// The account's disk IO is capped at 30 MB/s for every site together. While the API is moving bytes it hands the
// worker a live share of the library's 21 MiB/s line (apps/api/src/media/throttle.ts, written to io-alloc.json);
// otherwise full-file reads and writes the worker does at disk speed (hashing, sealing) are paced to 8 MiB/s.
import { readFileSync } from 'node:fs';

export const WORKER_IO_BPS = 8 * 2 ** 20;
/** An allocation older than this means the API stopped allocating (idle or down). */
const STALE_MS = 10_000;

let allocFile: string | null = null;
let cached = { at: -Infinity, bps: WORKER_IO_BPS };

/** Set once at startup: MEDIA_ROOT/io-alloc.json. */
export function setAllocFile(file: string | null) {
  allocFile = file;
  cached = { at: -Infinity, bps: WORKER_IO_BPS };
}

/** The worker's current disk budget in bytes/s, re-read at most once a second. */
export function workerBps(now = Date.now()) {
  if (now - cached.at < 1000) return cached.bps;
  let bps = WORKER_IO_BPS;
  try {
    const a = JSON.parse(readFileSync(allocFile ?? '', 'utf8')) as { workerBps?: unknown; at?: unknown };
    if (typeof a.workerBps === 'number' && a.workerBps > 0 && typeof a.at === 'number' && now - a.at <= STALE_MS) bps = a.workerBps;
  } catch {
    /* missing or half-written: the fixed rate */
  }
  cached = { at: now, bps };
  return bps;
}

/** Call with the bytes just read or written; it waits whenever they get ahead of `bps` (read per call). */
export function pacer(bps: number | (() => number) = workerBps) {
  let due = Date.now();
  return async (n: number) => {
    const now = Date.now();
    due = Math.max(due, now - 1000) + (n / (typeof bps === 'function' ? bps() : bps)) * 1000;
    if (due > now) await new Promise((r) => setTimeout(r, due - now));
  };
}
