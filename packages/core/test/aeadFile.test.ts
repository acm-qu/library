import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AeadFileError,
  chunkSpan,
  encryptedSize,
  KEY_BYTES,
  openRange,
  PREFIX_BYTES,
  randomKey,
  readHeader,
  sealFile,
  TAG_BYTES,
  unwrapKey,
  wrapKey,
} from '../src/crypto/index.ts';
import { newId } from '../src/ids.ts';

const CHUNK = 4096; // small chunks so the tests cross many boundaries quickly
let dir: string;
beforeAll(async () => (dir = await mkdtemp(path.join(tmpdir(), 'acmenc-'))));
afterAll(() => rm(dir, { recursive: true, force: true }));

async function collect(it: AsyncIterable<Buffer>) {
  const parts: Buffer[] = [];
  for await (const p of it) parts.push(p);
  return Buffer.concat(parts);
}

async function sealed(size: number) {
  const plain = randomKey(size);
  const id = newId();
  const key = randomKey(KEY_BYTES);
  const src = path.join(dir, `${id}.bin`);
  const dst = path.join(dir, `${id}.enc`);
  await writeFile(src, plain);
  await sealFile(src, dst, key, id, CHUNK);
  return { plain, id, key, dst };
}

describe('ACMENC01', () => {
  it.each([0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 5 * CHUNK + 123])('round-trips %i bytes', async (size) => {
    const { plain, id, key, dst } = await sealed(size);
    expect((await stat(dst)).size).toBe(encryptedSize(size, CHUNK));
    expect((await readHeader(dst)).plaintextSize).toBe(size);
    expect((await collect(openRange(dst, key, id))).equals(plain)).toBe(true);
  });

  it('serves arbitrary ranges by decrypting only overlapping chunks', async () => {
    const { plain, id, key, dst } = await sealed(7 * CHUNK + 999);
    for (const [a, b] of [[0, 0], [10, 20], [CHUNK - 1, CHUNK], [CHUNK * 2 + 5, CHUNK * 5 + 7], [plain.length - 1, plain.length - 1]] as const) {
      expect((await collect(openRange(dst, key, id, a, b))).equals(plain.subarray(a, b + 1))).toBe(true);
    }
  });

  it('computes the chunk span like the plan example', () => {
    const s = chunkSpan(1_500_000, 2_600_000, { chunkSize: 1 << 20, plaintextSize: 3_000_000 });
    expect([s.first, s.last]).toEqual([1, 2]);
    expect(s.offsetOf(1)).toBe(PREFIX_BYTES + (1 << 20) + TAG_BYTES);
    expect(() => chunkSpan(0, 3_000_000, { chunkSize: 1 << 20, plaintextSize: 3_000_000 })).toThrow(RangeError);
  });

  it('rejects the wrong key and the wrong asset id', async () => {
    const { id, key, dst } = await sealed(3 * CHUNK);
    await expect(collect(openRange(dst, randomKey(KEY_BYTES), id))).rejects.toThrow(AeadFileError);
    await expect(collect(openRange(dst, key, newId()))).rejects.toThrow(AeadFileError);
  });

  it('detects tampering, truncation and chunk reordering', async () => {
    const { id, key, dst } = await sealed(3 * CHUNK + 10);
    const bytes = await readFile(dst);

    const flipped = Buffer.from(bytes);
    flipped[PREFIX_BYTES + CHUNK + 40]! ^= 1;
    await writeFile(dst, flipped);
    await expect(collect(openRange(dst, key, id))).rejects.toThrow(/chunk 1 failed/);

    // Drop the last chunk and rewrite the header to claim the shorter length: is_last no longer matches.
    const n = CHUNK + TAG_BYTES;
    const truncated = Buffer.from(bytes.subarray(0, PREFIX_BYTES + 3 * n));
    truncated.writeBigUInt64LE(BigInt(3 * CHUNK), 12);
    await writeFile(dst, truncated);
    await expect(collect(openRange(dst, key, id))).rejects.toThrow(/chunk 2 failed/);

    const swapped = Buffer.from(bytes);
    bytes.copy(swapped, PREFIX_BYTES, PREFIX_BYTES + n, PREFIX_BYTES + 2 * n);
    bytes.copy(swapped, PREFIX_BYTES + n, PREFIX_BYTES, PREFIX_BYTES + n);
    await writeFile(dst, swapped);
    await expect(collect(openRange(dst, key, id))).rejects.toThrow(/chunk 0 failed/);
  });

  it('rejects a file whose size does not match its header', async () => {
    const { dst } = await sealed(CHUNK);
    await writeFile(dst, Buffer.concat([await readFile(dst), Buffer.alloc(1)]));
    await expect(readHeader(dst)).rejects.toThrow(/size does not match/);
  });
});

describe('key wrapping', () => {
  it('wraps and unwraps; a different master key fails', () => {
    const master = randomKey(32);
    const k = randomKey(KEY_BYTES);
    expect(unwrapKey(wrapKey(k, master), master).equals(k)).toBe(true);
    expect(() => unwrapKey(wrapKey(k, master), randomKey(32))).toThrow(/authentication/);
  });
});
