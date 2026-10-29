// Delete an asset's files and rows (after DELETE /assets/:id or an event delete). Idempotent.
import { rm } from 'node:fs/promises';
import { assets, type Job } from '@acm/core/db';
import { assetDir } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';

export async function runPurge(ctx: Ctx, job: Job): Promise<'ok'> {
  if (!job.assetId) return 'ok';
  await rm(assetDir(ctx.cfg.MEDIA_ROOT, job.assetId), { recursive: true, force: true });
  await ctx.db.delete(assets).where(eq(assets.id, job.assetId));
  return 'ok';
}
