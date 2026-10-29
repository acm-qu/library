// The handoff's ETA formula (§8.6), shared by the API (My uploads, queue) and the worker (jobs.est_seconds).
import type { HdrFormat } from './enums.ts';

export type EtaJob = {
  kind: 'image' | 'video';
  hdr: HdrFormat | null;
  durationS: number | null;
  progress: number | null;
};
export type Rho = { sdr: number; hdr: number };

export const DEFAULT_RHO: Rho = { sdr: 0.6, hdr: 1.2 };
export const IMAGE_SECONDS = 3;
export const HDR_FIXED_SECONDS = 60;
export const RHO_ALPHA = 0.2;

export const isHdr = (hdr: HdrFormat | null): boolean => hdr === 'hlg' || hdr === 'pq';

export function jobCost(j: EtaJob, rho: Rho): number {
  if (j.kind === 'image') return IMAGE_SECONDS;
  const d = j.durationS ?? 0;
  return isHdr(j.hdr) ? rho.hdr * d + HDR_FIXED_SECONDS : rho.sdr * d;
}

/** Seconds until each job finishes, in claim order (running job first, scaled by its remaining progress). */
export function queueEtas(ordered: EtaJob[], rho: Rho): number[] {
  let t = 0;
  return ordered.map((j) => (t += jobCost(j, rho) * (1 - clamp01(j.progress ?? 0))));
}

/** EMA update after a video job; `encodeS` excludes tone-curve scoring, which HDR_FIXED_SECONDS covers. */
export function nextRho(current: number, encodeS: number, durationS: number): number {
  if (!(durationS > 0) || !(encodeS >= 0)) return current;
  return (1 - RHO_ALPHA) * current + RHO_ALPHA * (encodeS / durationS);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
