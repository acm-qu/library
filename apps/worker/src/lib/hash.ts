import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pacer } from './pace.ts';

export async function sha256File(file: string): Promise<Buffer> {
  const h = createHash('sha256');
  const pace = pacer();
  for await (const c of createReadStream(file, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    h.update(c);
    await pace(c.length);
  }
  return h.digest();
}
