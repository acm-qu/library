// ACMENC01: chunked XChaCha20-Poly1305 for core-tier originals at rest.
//
//   header   32 B  "ACMENC01" | chunk_size u32le | plaintext_size u64le | reserved 12 (zero)
//   nonce    24 B  nonce_base (random per file)
//   chunk i        ciphertext(min(chunk_size, remaining)) + 16 B tag
//
// nonce_i = nonce_base with its last 8 bytes XOR u64le(i); AD = asset_id (16) | u64le(i) | u8(is_last).
// Reordering, truncation, extension and header tampering all fail authentication, and any byte range
// can be served by decrypting only the chunks it overlaps.
import { open } from 'node:fs/promises';
import sodium from 'sodium-native';
import { uuidBytes } from '../ids.ts';

export const MAGIC = Buffer.from('ACMENC01', 'ascii');
export const HEADER_BYTES = 32;
export const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES; // 24
export const PREFIX_BYTES = HEADER_BYTES + NONCE_BYTES; // 56
export const TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES; // 16
export const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES; // 32
export const DEFAULT_CHUNK = 1 << 20;

export type Header = { chunkSize: number; plaintextSize: number; nonceBase: Buffer };

export class AeadFileError extends Error {}

export const chunkCount = (plaintextSize: number, chunkSize: number): number =>
  Math.max(1, Math.ceil(plaintextSize / chunkSize));

export const encryptedSize = (plaintextSize: number, chunkSize = DEFAULT_CHUNK): number =>
  PREFIX_BYTES + plaintextSize + chunkCount(plaintextSize, chunkSize) * TAG_BYTES;

/** Chunks overlapping the inclusive plaintext range [start, end], and where each one sits in the file. */
export function chunkSpan(start: number, end: number, h: Pick<Header, 'chunkSize' | 'plaintextSize'>) {
  if (!(start >= 0 && end >= start && end < h.plaintextSize)) throw new RangeError('range not satisfiable');
  const first = Math.floor(start / h.chunkSize);
  const last = Math.floor(end / h.chunkSize);
  return { first, last, offsetOf: (i: number) => PREFIX_BYTES + i * (h.chunkSize + TAG_BYTES) };
}

function nonceFor(base: Buffer, i: number): Buffer {
  const n = Buffer.from(base);
  const tail = n.subarray(NONCE_BYTES - 8);
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64LE(BigInt(i));
  for (let b = 0; b < 8; b++) tail[b]! ^= ctr[b]!;
  return n;
}

function adFor(assetId: Buffer, i: number, isLast: boolean): Buffer {
  const ad = Buffer.alloc(16 + 8 + 1);
  assetId.copy(ad, 0);
  ad.writeBigUInt64LE(BigInt(i), 16);
  ad[24] = isLast ? 1 : 0;
  return ad;
}

export function encodeHeader(h: Header): Buffer {
  const b = Buffer.alloc(PREFIX_BYTES);
  MAGIC.copy(b, 0);
  b.writeUInt32LE(h.chunkSize, 8);
  b.writeBigUInt64LE(BigInt(h.plaintextSize), 12);
  h.nonceBase.copy(b, HEADER_BYTES);
  return b;
}

export function decodeHeader(b: Buffer): Header {
  if (b.length < PREFIX_BYTES || !b.subarray(0, 8).equals(MAGIC)) throw new AeadFileError('not an ACMENC01 file');
  const chunkSize = b.readUInt32LE(8);
  const plaintextSize = Number(b.readBigUInt64LE(12));
  if (chunkSize < 1024 || chunkSize > 1 << 26 || !Number.isSafeInteger(plaintextSize)) throw new AeadFileError('bad header');
  if (!b.subarray(20, HEADER_BYTES).equals(Buffer.alloc(12))) throw new AeadFileError('bad header');
  return { chunkSize, plaintextSize, nonceBase: Buffer.from(b.subarray(HEADER_BYTES, PREFIX_BYTES)) };
}

export function sealChunk(plain: Buffer, key: Buffer, h: Header, assetId: Buffer, i: number, isLast: boolean): Buffer {
  const out = Buffer.alloc(plain.length + TAG_BYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(out, plain, adFor(assetId, i, isLast), null, nonceFor(h.nonceBase, i), key);
  return out;
}

export function openChunk(cipher: Buffer, key: Buffer, h: Header, assetId: Buffer, i: number, isLast: boolean): Buffer {
  if (cipher.length < TAG_BYTES) throw new AeadFileError(`chunk ${i} truncated`);
  const out = Buffer.alloc(cipher.length - TAG_BYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, cipher, adFor(assetId, i, isLast), nonceFor(h.nonceBase, i), key);
  } catch {
    throw new AeadFileError(`chunk ${i} failed authentication`);
  }
  return out;
}

function checkKey(key: Buffer) {
  if (key.length !== KEY_BYTES) throw new TypeError(`file key must be ${KEY_BYTES} bytes`);
}

/** Encrypt `src` into `dst` (created exclusively). The caller renames `dst` into place. */
export async function sealFile(src: string, dst: string, key: Buffer, assetId: string, chunkSize = DEFAULT_CHUNK): Promise<Header> {
  checkKey(key);
  const id = uuidBytes(assetId);
  const input = await open(src, 'r');
  const output = await open(dst, 'wx', 0o600);
  try {
    const plaintextSize = (await input.stat()).size;
    const nonceBase = Buffer.alloc(NONCE_BYTES);
    sodium.randombytes_buf(nonceBase);
    const h: Header = { chunkSize, plaintextSize, nonceBase };
    await output.write(encodeHeader(h));
    const n = chunkCount(plaintextSize, chunkSize);
    const buf = Buffer.alloc(chunkSize);
    for (let i = 0; i < n; i++) {
      const want = Math.min(chunkSize, plaintextSize - i * chunkSize);
      const { bytesRead } = await input.read(buf, 0, want, i * chunkSize);
      if (bytesRead !== want) throw new AeadFileError('source changed while sealing');
      await output.write(sealChunk(buf.subarray(0, want), key, h, id, i, i === n - 1));
    }
    await output.sync();
    return h;
  } finally {
    await input.close();
    await output.close();
  }
}

export async function readHeader(path: string): Promise<Header> {
  const fh = await open(path, 'r');
  try {
    const b = Buffer.alloc(PREFIX_BYTES);
    await fh.read(b, 0, PREFIX_BYTES, 0);
    const h = decodeHeader(b);
    if ((await fh.stat()).size !== encryptedSize(h.plaintextSize, h.chunkSize)) throw new AeadFileError('file size does not match header');
    return h;
  } finally {
    await fh.close();
  }
}

/**
 * Decrypt the inclusive plaintext range [start, end] (defaults to the whole file), yielding plaintext slices.
 * Authentication failures throw mid-stream; callers must abort the response rather than send partial data as success.
 */
export async function* openRange(path: string, key: Buffer, assetId: string, start = 0, end?: number): AsyncGenerator<Buffer> {
  checkKey(key);
  const id = uuidBytes(assetId);
  const h = await readHeader(path);
  if (h.plaintextSize === 0) return;
  const last = end ?? h.plaintextSize - 1;
  const span = chunkSpan(start, last, h);
  const n = chunkCount(h.plaintextSize, h.chunkSize);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(h.chunkSize + TAG_BYTES);
    for (let i = span.first; i <= span.last; i++) {
      const plainLen = Math.min(h.chunkSize, h.plaintextSize - i * h.chunkSize);
      const { bytesRead } = await fh.read(buf, 0, plainLen + TAG_BYTES, span.offsetOf(i));
      if (bytesRead !== plainLen + TAG_BYTES) throw new AeadFileError(`chunk ${i} truncated`);
      const plain = openChunk(buf.subarray(0, bytesRead), key, h, id, i, i === n - 1);
      const from = i === span.first ? start - i * h.chunkSize : 0;
      const to = i === span.last ? last - i * h.chunkSize + 1 : plain.length;
      yield plain.subarray(from, to);
    }
  } finally {
    await fh.close();
  }
}

/** Decrypt a whole ACMENC01 file to `dst` (created exclusively, mode 600). Used for re-processing and retiering. */
export async function openFileTo(src: string, dst: string, key: Buffer, assetId: string): Promise<void> {
  const out = await open(dst, 'wx', 0o600);
  try {
    for await (const part of openRange(src, key, assetId)) await out.write(part);
    await out.sync();
  } finally {
    await out.close();
  }
}
