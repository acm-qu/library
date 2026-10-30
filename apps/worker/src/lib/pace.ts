// The account's disk IO is capped at 30 MB/s for every site together. Full-file reads and writes the worker does at
// disk speed (hashing, sealing) are paced to 8 MiB/s; uploads (≤ 5) and media serving (≤ 5 + 3) keep the rest.
export const WORKER_IO_BPS = 8 * 2 ** 20;

/** Call with the bytes just read or written; it waits whenever the running average gets ahead of `bps`. */
export function pacer(bps = WORKER_IO_BPS) {
  const start = Date.now();
  let bytes = 0;
  return async (n: number) => {
    bytes += n;
    const ahead = (bytes / bps) * 1000 - (Date.now() - start);
    if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
  };
}
