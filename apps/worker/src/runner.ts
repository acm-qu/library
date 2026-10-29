// One cron tick: reset jobs left running by a dead runner, then claim and run jobs one at a time until the queue
// is empty or the deadline passes. flock (in the crontab) guarantees a single runner; the deadline is checked
// between jobs only, so a long encode always finishes.
import { appSettings, assets, type Job, jobs } from '@acm/core/db';
import { and, eq, sql } from 'drizzle-orm';
import { Cancelled, type Ctx, jobScope, Permanent } from './context.ts';
import { ChildFailed } from './lib/spawn.ts';
import { runProcess } from './jobs/process.ts';
import { runPurge } from './jobs/purge.ts';
import { runRetier } from './jobs/retier.ts';

export const DEADLINE_MS = 50 * 60_000;
export const BACKOFF_MS = 5 * 60_000;

export async function tick(ctx: Ctx) {
  await ctx.db
    .insert(appSettings)
    .values({ key: 'worker_tick', value: new Date().toISOString() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: new Date().toISOString() } });
}

/** Rows left 'running' belong to a runner that died. Their attempt was counted at claim time. */
export async function resetStale(ctx: Ctx) {
  const exhausted = await ctx.db
    .update(jobs)
    .set({ state: 'failed', finishedAt: new Date(), lastError: 'worker_died' })
    .where(and(eq(jobs.state, 'running'), sql`${jobs.attempts} >= ${jobs.maxAttempts}`))
    .returning();
  for (const j of exhausted) await markAssetFailed(ctx, j);
  const requeued = await ctx.db.update(jobs).set({ state: 'queued', step: null, progress: null }).where(eq(jobs.state, 'running')).returning({ id: jobs.id });
  if (requeued.length || exhausted.length) ctx.log.warn({ requeued: requeued.length, failed: exhausted.length }, 'reset stale jobs');
}

export async function claim(ctx: Ctx): Promise<Job | null> {
  const res = await ctx.db.execute<Record<string, unknown>>(sql`
    update ${jobs} set state = 'running', started_at = now(), finished_at = null, attempts = attempts + 1, step = null, progress = null
    where id = (
      select id from ${jobs}
      where state = 'queued' and run_after <= now() and attempts < max_attempts
      order by priority desc, created_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = res.rows[0]?.id as string | undefined;
  if (!id) return null;
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

async function markAssetFailed(ctx: Ctx, job: Job) {
  if (!job.assetId || job.kind === 'purge') return;
  // Only first-time processing takes an asset to 'failed'; a failed re-process leaves the ready outputs alone.
  await ctx.db
    .update(assets)
    .set({ status: 'failed', updatedAt: new Date() })
    .where(and(eq(assets.id, job.assetId), sql`${assets.status} in ('queued','processing')`));
}

export async function runJob(ctx: Ctx, job: Job) {
  const scope = jobScope(ctx, job);
  const started = Date.now();
  try {
    const outcome = job.kind === 'purge' ? await runPurge(ctx, job) : job.kind === 'retier' ? await runRetier(ctx, job) : await runProcess(ctx, job, scope);
    await ctx.db.update(jobs).set({ state: 'done', outcome: outcome ?? 'ok', finishedAt: new Date(), step: null, progress: 1, lastError: null }).where(eq(jobs.id, job.id));
    ctx.log.info({ job: job.id, kind: job.kind, asset: job.assetId, ms: Date.now() - started, outcome: outcome ?? 'ok' }, 'job done');
  } catch (e) {
    // A child killed because the job was cancelled reports ChildFailed('cancelled'); it is a cancel, not a failure.
    if (e instanceof Cancelled || (e instanceof ChildFailed && e.code === 'cancelled')) {
      await ctx.db.update(jobs).set({ finishedAt: new Date(), step: null }).where(eq(jobs.id, job.id));
      await markAssetFailed(ctx, job);
      ctx.log.info({ job: job.id }, 'job cancelled');
      return;
    }
    const code = e instanceof Permanent ? e.code : e instanceof ChildFailed ? e.code : 'error';
    const permanent = e instanceof Permanent;
    const last = permanent || job.attempts >= job.maxAttempts;
    await ctx.db
      .update(jobs)
      .set(
        last
          ? { state: 'failed', finishedAt: new Date(), lastError: code, step: null }
          : { state: 'queued', runAfter: new Date(Date.now() + BACKOFF_MS * job.attempts), lastError: code, step: null, progress: null },
      )
      .where(eq(jobs.id, job.id));
    if (last) await markAssetFailed(ctx, job);
    ctx.log.error({ job: job.id, kind: job.kind, asset: job.assetId, attempt: job.attempts, code, err: e, stderr: e instanceof ChildFailed ? e.stderrTail.slice(-1500) : undefined }, last ? 'job failed' : 'job will retry');
  }
}

export async function runUntil(ctx: Ctx, deadline = Date.now() + DEADLINE_MS) {
  await tick(ctx);
  await resetStale(ctx);
  let n = 0;
  while (Date.now() < deadline) {
    const job = await claim(ctx);
    if (!job) break;
    await runJob(ctx, job);
    await tick(ctx);
    n++;
  }
  return n;
}
