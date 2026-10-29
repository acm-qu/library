import type { ServerConfig } from '@acm/core/config';
import { type Db, type Job, jobs } from '@acm/core/db';
import { eq } from 'drizzle-orm';
import type { Logger } from './log.ts';

export type Ctx = { db: Db; cfg: ServerConfig; log: Logger };

export class Cancelled extends Error {}
/** A failure that retrying won't fix: the job fails at once and the asset is marked failed. */
export class Permanent extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
  }
}

/** Per-job helpers: step/progress reporting and the cancellation check between steps. */
export function jobScope(ctx: Ctx, job: Job) {
  let lastWrite = 0;
  return {
    async step(step: string, progress: number | null = null) {
      await ctx.db.update(jobs).set({ step, progress }).where(eq(jobs.id, job.id));
      await this.throwIfCancelled();
    },
    /** Throttled to one write every 2 s; progress bars poll every 5 s anyway. */
    async progress(progress: number) {
      if (Date.now() - lastWrite < 2000) return;
      lastWrite = Date.now();
      await ctx.db.update(jobs).set({ progress: Math.min(1, Math.max(0, progress)) }).where(eq(jobs.id, job.id));
    },
    async isCancelled() {
      const [row] = await ctx.db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, job.id));
      return row?.state === 'cancelled';
    },
    async throwIfCancelled() {
      if (await this.isCancelled()) throw new Cancelled();
    },
  };
}
export type JobScope = ReturnType<typeof jobScope>;
