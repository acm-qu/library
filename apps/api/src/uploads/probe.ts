// Quick header probe at ingest: enough for grid layout and the ETA (dimensions, duration, HDR transfer).
// Bounded: images read at most 2 MiB; ffprobe only reads headers and is killed after 20 s. The worker re-reads
// everything properly, so a failed probe leaves fields null instead of failing the upload.
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import type { HdrFormat } from '@acm/core/db';
import { imageSize } from 'image-size';

export type Probe = { width: number | null; height: number | null; durationS: number | null; fps: number | null; hdr: HdrFormat | null };
const EMPTY: Probe = { width: null, height: null, durationS: null, fps: null, hdr: null };

export async function probeImage(file: string): Promise<Probe> {
  const fh = await open(file, 'r');
  try {
    const b = Buffer.alloc(2 * 1024 * 1024);
    const { bytesRead } = await fh.read(b, 0, b.length, 0);
    const r = imageSize(b.subarray(0, bytesRead));
    // EXIF orientations 5-8 mean the stored pixels are rotated a quarter turn.
    const swap = (r.orientation ?? 1) >= 5;
    return { ...EMPTY, width: (swap ? r.height : r.width) ?? null, height: (swap ? r.width : r.height) ?? null };
  } catch {
    return EMPTY;
  } finally {
    await fh.close();
  }
}

export function hdrFromTransfer(transfer: string | undefined): HdrFormat {
  if (transfer === 'arib-std-b67') return 'hlg';
  if (transfer === 'smpte2084') return 'pq';
  if (!transfer || ['bt709', 'smpte170m', 'bt470bg', 'bt470m', 'iec61966-2-1', 'bt2020-10', 'bt2020-12', 'gamma22', 'unknown'].includes(transfer)) return 'sdr';
  return 'unknown'; // e.g. log profiles; the worker routes these to needs_review
}

type FfStream = { codec_type?: string; width?: number; height?: number; color_transfer?: string; avg_frame_rate?: string; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] };

export function parseFfprobe(json: { streams?: FfStream[]; format?: { duration?: string } }): Probe {
  const v = json.streams?.find((s) => s.codec_type === 'video');
  if (!v) return EMPTY;
  const rotation = Number(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  const quarter = Math.abs(rotation) % 180 === 90;
  const [num, den] = (v.avg_frame_rate ?? '0/1').split('/').map(Number);
  const duration = Number(json.format?.duration);
  return {
    width: (quarter ? v.height : v.width) ?? null,
    height: (quarter ? v.width : v.height) ?? null,
    durationS: Number.isFinite(duration) ? duration : null,
    fps: num && den ? Math.round((num / den) * 100) / 100 : null,
    hdr: hdrFromTransfer(v.color_transfer),
  };
}

export function probeVideo(ffprobe: string, file: string): Promise<Probe> {
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, OMP_NUM_THREADS: '1' } },
      (err, stdout) => {
        if (err) return resolve(EMPTY);
        try {
          resolve(parseFfprobe(JSON.parse(stdout)));
        } catch {
          resolve(EMPTY);
        }
      },
    );
  });
}
