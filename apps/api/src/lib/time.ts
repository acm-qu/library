export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** Run `fn`, then wait until at least `floorMs` has passed since the start, so timing doesn't leak which branch ran. */
export async function withFloor<T>(floorMs: number, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    await sleep(floorMs - (performance.now() - start));
  }
}
