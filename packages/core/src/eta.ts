// The handoff's ETA formula (§8.6), shared by the API (My uploads, queue) and the worker (jobs.est_seconds).
import type { HdrFormat } from './enums.ts';

export type EtaJob = {
  kind: 'image' | 'video';
  hdr: HdrFormat | null;
  durationS: number | null;
  progress: number | null;
};
/** Encode seconds per second of video, plus the fixed cost of an HDR video (tone-curve scoring, when it runs). */
export type Rho = { sdr: number; hdr: number; hdrFixed?: number };

export const DEFAULT_RHO: Rho = { sdr: 0.6, hdr: 1.2 };
export const IMAGE_SECONDS = 3;
export const HDR_FIXED_SECONDS = 60;
/** Automatic tone-curve scoring on the host: 8 frames × 4 curves at 1024 px measured 5.6 min (Oct 2026). */
export const SCORE_SECONDS = 340;
export const RHO_ALPHA = 0.2;

export const isHdr = (hdr: HdrFormat | null): boolean => hdr === 'hlg' || hdr === 'pq';

export function jobCost(j: EtaJob, rho: Rho): number {
  if (j.kind === 'image') return IMAGE_SECONDS;
  const d = j.durationS ?? 0;
  return isHdr(j.hdr) ? rho.hdr * d + (rho.hdrFixed ?? HDR_FIXED_SECONDS) : rho.sdr * d;
}

/** Seconds until each job finishes, in claim order (running job first, scaled by its remaining progress). */
export function queueEtas(ordered: EtaJob[], rho: Rho): number[] {
  let t = 0;
  return ordered.map((j) => (t += jobCost(j, rho) * (1 - clamp01(j.progress ?? 0))));
}

/** EMA update after a video job; `encodeS` excludes tone-curve scoring, which `hdrFixed` covers. */
export function nextRho(current: number, encodeS: number, durationS: number): number {
  if (!(durationS > 0) || !(encodeS >= 0)) return current;
  return (1 - RHO_ALPHA) * current + RHO_ALPHA * (encodeS / durationS);
}

/** EMA of the measured scoring time, so ETAs follow the real host once automatic selection runs. */
export function nextScoreSeconds(current: number, measuredS: number): number {
  return measuredS > 0 ? (1 - RHO_ALPHA) * current + RHO_ALPHA * measuredS : current;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
