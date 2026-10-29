// File type from magic bytes, never from the name. Accepts the handoff's list: JPEG, PNG, HEIC/HEIF, AVIF, WebP,
// MP4, MOV (QuickTime).
import { open } from 'node:fs/promises';

export type Sniffed = { kind: 'image' | 'video'; mime: string; ext: string };

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'dash', 'mmp4', 'MSNV', 'XAVC', 'f4v ']);

export function sniffBuffer(b: Buffer): Sniffed | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const boxSize = Math.min(b.readUInt32BE(0), b.length);
    const brands = [b.toString('latin1', 8, 12)];
    for (let o = 16; o + 4 <= boxSize; o += 4) brands.push(b.toString('latin1', o, o + 4));
    const major = brands[0]!;
    // Major brand decides first; compatible brands break ties (an AVIF lists mif1, a HEIC may list heic).
    if (AVIF_BRANDS.has(major)) return { kind: 'image', mime: 'image/avif', ext: 'avif' };
    if (HEIC_BRANDS.has(major)) return { kind: 'image', mime: 'image/heic', ext: 'heic' };
    if (major === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    if (HEIF_BRANDS.has(major)) {
      if (brands.some((x) => AVIF_BRANDS.has(x))) return { kind: 'image', mime: 'image/avif', ext: 'avif' };
      return { kind: 'image', mime: brands.some((x) => HEIC_BRANDS.has(x)) ? 'image/heic' : 'image/heif', ext: brands.some((x) => HEIC_BRANDS.has(x)) ? 'heic' : 'heif' };
    }
    if (MP4_BRANDS.has(major) || brands.some((x) => MP4_BRANDS.has(x))) return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
    if (brands.includes('qt  ')) return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    return null;
  }
  // Old QuickTime files may start with a wide/mdat/moov/free atom instead of ftyp.
  if (b.length >= 8 && ['wide', 'mdat', 'moov', 'free', 'skip'].includes(b.toString('latin1', 4, 8))) return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
  return null;
}

export async function sniffFile(file: string): Promise<Sniffed | null> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    return sniffBuffer(b.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
