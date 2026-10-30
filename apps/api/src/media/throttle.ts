// The account's disk IO is capped at 30 MB/s for every site together. Large media responses (originals, HLS
// segments) share this budget so viewers and downloads can never take more than their part of it; small files
// (thumbs, posters, playlists) skip it, they are tiny and usually come from the page cache.
import { Readable } from 'node:stream';

export const SERVE_BPS = 8 * 2 ** 20;
export const PACE_OVER = 2 ** 20;
let freeAt = 0; // when the shared budget has room again (ms)

async function take(bytes: number) {
  const now = Date.now();
  const start = Math.max(now, freeAt);
  freeAt = start + (bytes / SERVE_BPS) * 1000;
  if (start > now) await new Promise((r) => setTimeout(r, start - now));
}

async function* paced(src: AsyncIterable<Buffer>) {
  for await (const chunk of src) {
    await take(chunk.length);
    yield chunk;
  }
}

/** The response body for `length` bytes: paced through the shared budget when it's large. */
export const servedAs = (src: Readable, length: number) => (length > PACE_OVER ? Readable.from(paced(src)) : src);
