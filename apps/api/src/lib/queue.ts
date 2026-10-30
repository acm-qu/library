// Queue position → ETA, using the shared formula. Jobs are taken in the worker's claim order.
import { appSettings, assets, type Db, jobs } from '@acm/core/db';
import { DEFAULT_RHO, HDR_FIXED_SECONDS, queueEtas, type Rho, SCORE_SECONDS } from '@acm/core/eta';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';

export async function loadRho(db: Db): Promise<Rho> {
  const rows = await db.select().from(appSettings).where(inArray(appSettings.key, ['rho_sdr', 'rho_hdr', 'score_seconds', 'tonemap_auto']));
  const get = (k: string, d: number) => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === 'number' && v > 0 ? v : d;
  };
  const auto = rows.find((r) => r.key === 'tonemap_auto')?.value === true;
  return { sdr: get('rho_sdr', DEFAULT_RHO.sdr), hdr: get('rho_hdr', DEFAULT_RHO.hdr), hdrFixed: auto ? get('score_seconds', SCORE_SECONDS) : HDR_FIXED_SECONDS };
}

export type ActiveJob = { jobId: string; assetId: string | null; kind: string; state: string; step: string | null; progress: number | null; readyInS: number | null };

/** The worker beats every minute (and during long jobs); older than this, nothing is being processed. */
export const STALE_TICK_MS = 5 * 60_000; // cron starts the worker every 2 min

async function workerAlive(db: Db): Promise<boolean> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'worker_tick'));
  return typeof row?.value === 'string' && Date.now() - Date.parse(row.value) < STALE_TICK_MS;
}

/**
 * Every queued or running job (except purges) with its ETA, in claim order (running first). A job waiting out a
 * retry backoff has no ETA and adds nothing to the others'; with a stale worker heartbeat every ETA is null
 * (a clock that keeps sliding is worse than "waiting for the processor").
 */
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
      backoff: sql<boolean>`${jobs.runAfter} > now()`, // the database's clock, as the worker's claim uses
    })
    .from(jobs)
    .leftJoin(assets, eq(assets.id, jobs.assetId))
    // Purges take a moment and nobody waits on them, so they don't count toward anyone's ETA.
    .where(and(inArray(jobs.state, ['queued', 'running']), ne(jobs.kind, 'purge')))
    .orderBy(sql`${jobs.state} = 'running' desc`, desc(jobs.priority), asc(jobs.createdAt));
  const [rho, alive] = await Promise.all([loadRho(db), workerAlive(db)]);
  const counted = rows.filter((r) => r.state === 'running' || !r.backoff);
  const etas = queueEtas(
    counted.map((r) => ({ kind: r.assetKind ?? 'image', hdr: r.hdr, durationS: r.durationS, progress: r.state === 'running' ? r.progress : null })),
    rho,
  );
  const etaOf = new Map(counted.map((r, i) => [r.jobId, Math.round(etas[i]!)]));
  return rows.map((r) => ({ jobId: r.jobId, assetId: r.assetId, kind: r.kind, state: r.state, step: r.step, progress: r.progress, readyInS: alive ? (etaOf.get(r.jobId) ?? null) : null }));
}

/** When the whole queue is done (0 when empty or unknown). */
export const drainOf = (list: ActiveJob[]) => Math.max(0, ...list.map((j) => j.readyInS ?? 0));

export const byAsset = (list: ActiveJob[]) => new Map(list.filter((j) => j.assetId).map((j) => [j.assetId!, j]));
