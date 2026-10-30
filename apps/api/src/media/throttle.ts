// The account's disk IO is capped at 30 MB/s for every site together, so the API's bytes share budgets: tus upload
// bodies (all uploads together, sized live, see uploadRate), large media files (originals, HLS data.ts) and small
// ones (thumbs, views, posters). A response is classed by its whole file, so Range slices of a big file pay the large
// budget.
import { Readable } from 'node:stream';
import { accountIoSince } from '../lib/compute.ts';
import { HttpError } from '../lib/errors.ts';

/** 70% of the account's 30 MB/s: the library's line, so the other sites always keep 30%. */
export const IO_TARGET_BPS = 21 * 2 ** 20;
export const UPLOAD_FLOOR_BPS = 2 * 2 ** 20;
/** Before the first measurement (and off Linux, where /proc isn't there). */
export const UPLOAD_START_BPS = 5 * 2 ** 20;
export const SERVE_BPS = 5 * 2 ** 20;
export const SMALL_BPS = 3 * 2 ** 20;
export const PACE_OVER = 2 ** 20;
/** Each held (paced) large response keeps an entry process busy; the account allows 150. */
export const MAX_PACED = 32;

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

/**
 * Uploads get whatever the 70% line leaves after everything else on the account (encodes, serving, the other sites),
 * between 2 MiB/s and the full 21 MiB/s; all uploaders split it. `accountBps` includes the uploads' own writes.
 */
export function uploadRate(accountBps: number | null, uploadBps: number) {
  if (accountBps === null) return UPLOAD_START_BPS;
  const others = Math.max(0, accountBps - uploadBps);
  return Math.min(IO_TARGET_BPS, Math.max(UPLOAD_FLOOR_BPS, IO_TARGET_BPS - others));
}

let uploadBps = UPLOAD_START_BPS;
let uploaded = 0; // upload bytes since the last sample
let sampler: NodeJS.Timeout | null = null;
let idleSamples = 0;

/** Samples the account's disk IO once a second while uploads are flowing; stops after 10 quiet seconds. */
function watchUploads() {
  if (sampler) return;
  let busy = false;
  let last = Date.now();
  sampler = setInterval(() => {
    if (busy) return;
    busy = true;
    void accountIoSince()
      .then((account) => {
        const now = Date.now();
        const mine = uploaded / Math.max(0.5, (now - last) / 1000);
        last = now;
        idleSamples = uploaded ? 0 : idleSamples + 1;
        uploaded = 0;
        uploadBps = uploadRate(account, mine);
        if (idleSamples >= 10 && sampler) {
          clearInterval(sampler);
          sampler = null;
          idleSamples = 0;
          uploadBps = UPLOAD_START_BPS;
        }
      })
      .finally(() => (busy = false));
  }, 1000);
  sampler.unref();
}

const takeUploadBudget = budget(() => uploadBps);
export const takeUpload = (bytes: number) => {
  watchUploads();
  uploaded += bytes;
  return takeUploadBudget(bytes);
};
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
