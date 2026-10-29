import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function sha256File(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest()));
  });
}
