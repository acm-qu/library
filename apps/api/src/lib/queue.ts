// Queue position → ETA, using the shared formula. Jobs are taken in the worker's claim order.
import { appSettings, assets, type Db, jobs } from '@acm/core/db';
import { DEFAULT_RHO, HDR_FIXED_SECONDS, queueEtas, type Rho, SCORE_SECONDS } from '@acm/core/eta';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';

export async function loadRho(db: Db): Promise<Rho> {
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, ['rho_sdr', 'rho_hdr', 'score_seconds', 'tonemap_auto']));
  const get = (k: string, d: number) => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === 'number' && v > 0 ? v : d;
  };
  const auto = rows.find((r) => r.key === 'tonemap_auto')?.value === true;
  return { sdr: get('rho_sdr', DEFAULT_RHO.sdr), hdr: get('rho_hdr', DEFAULT_RHO.hdr), hdrFixed: auto ? get('score_seconds', SCORE_SECONDS) : HDR_FIXED_SECONDS };
}

export type ActiveJob = { jobId: string; assetId: string | null; kind: string; state: string; step: string | null; progress: number | null; readyInS: number };

/** Every queued or running job with its ETA, in claim order (running first). */
export async function activeJobs(db: Db): Promise<ActiveJob[]> {
  const rows = await db
    .select({
      jobId: jobs.id,
      assetId: jobs.assetId,
      kind: jobs.kind,
      state: jobs.state,
      step: jobs.step,
      progress: jobs.progress,
      assetKind: assets.kind,
      hdr: assets.hdr,
      durationS: assets.durationS,
    })
    .from(jobs)
    .leftJoin(assets, eq(assets.id, jobs.assetId))
    .where(inArray(jobs.state, ['queued', 'running']))
    .orderBy(sql`${jobs.state} = 'running' desc`, desc(jobs.priority), asc(jobs.createdAt));
  const rho = await loadRho(db);
  const etas = queueEtas(
    rows.map((r) => ({ kind: r.assetKind ?? 'image', hdr: r.hdr, durationS: r.durationS, progress: r.state === 'running' ? r.progress : null })),
    rho,
  );
  return rows.map((r, i) => ({ jobId: r.jobId, assetId: r.assetId, kind: r.kind, state: r.state, step: r.step, progress: r.progress, readyInS: Math.round(etas[i]!) }));
}

export const byAsset = (list: ActiveJob[]) => new Map(list.filter((j) => j.assetId).map((j) => [j.assetId!, j]));
