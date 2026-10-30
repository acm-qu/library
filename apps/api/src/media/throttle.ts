// The account's disk IO is capped at 30 MB/s for every site together, so the API's bytes share fixed budgets:
// tus upload bodies (all uploads together), large media files (originals, HLS data.ts) and small ones (thumbs,
// views, posters). A response is classed by its whole file, so Range slices of a big file pay the large budget.
import { Readable } from 'node:stream';
import { HttpError } from '../lib/errors.ts';

export const UPLOAD_BPS = 5 * 2 ** 20;
export const SERVE_BPS = 5 * 2 ** 20;
export const SMALL_BPS = 3 * 2 ** 20;
export const PACE_OVER = 2 ** 20;
/** Each held (paced) large response keeps an entry process busy; the account allows 150. */
export const MAX_PACED = 32;

/** A shared byte budget: awaiting `take(n)` keeps every caller together under `bps`. */
export function budget(bps: number) {
  let freeAt = 0; // when the budget has room again (ms)
  return async (bytes: number) => {
    const now = Date.now();
    const start = Math.max(now, freeAt);
    freeAt = start + (bytes / bps) * 1000;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  };
}

export const takeUpload = budget(UPLOAD_BPS);
const takeLarge = budget(SERVE_BPS);
const takeSmall = budget(SMALL_BPS);

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
