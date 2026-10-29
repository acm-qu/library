// process / reprocess: hash the original first (sets duplicate_of), then the kind-specific pipeline.
import { type Asset, assets, type Job } from '@acm/core/db';
import { tmpDir } from '@acm/core/paths';
import { mkdir, rm } from 'node:fs/promises';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Ctx, JobScope } from '../context.ts';
import { Permanent } from '../context.ts';
import { sha256File } from '../lib/hash.ts';
import { plainOriginal, reconcileOriginal } from '../lib/seal.ts';
import { processImage } from './image.ts';
import { processVideo } from './video.ts';

export async function runProcess(ctx: Ctx, job: Job, scope: JobScope): Promise<'ok' | 'needs_review'> {
  if (!job.assetId) throw new Permanent('no_asset');
  const [a0] = await ctx.db.select().from(assets).where(eq(assets.id, job.assetId));
  if (!a0 || a0.deletedAt || a0.status === 'deleting') return 'ok';
  let a: Asset = a0;
  if (a.status === 'queued' || a.status === 'failed' || a.status === 'needs_review') {
    [a] = await ctx.db.update(assets).set({ status: 'processing', updatedAt: new Date() }).where(eq(assets.id, a.id)).returning() as [Asset];
  }
  const scratch = tmpDir(ctx.cfg.MEDIA_ROOT, job.id);
  await mkdir(scratch, { recursive: true });
  try {
    return await run(ctx, job, a, scope);
  } finally {
    // Removes any decrypted copy of a core original along with the job's other scratch files.
    await rm(scratch, { recursive: true, force: true });
  }
}

async function run(ctx: Ctx, job: Job, a: Asset, scope: JobScope): Promise<'ok' | 'needs_review'> {
  const src = await plainOriginal(ctx, a, job.id).catch((e) => {
    throw new Permanent('original_missing', e instanceof Error ? e.message : undefined);
  });

  if (!a.originalSha256) {
    await scope.step('Checking file', 0.05);
    const sha = await sha256File(src).catch(() => {
      throw new Permanent('original_missing');
    });
    const [dup] = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.eventId, a.eventId), eq(assets.originalSha256, sha), ne(assets.id, a.id), isNull(assets.deletedAt), sql`${assets.status} <> 'deleting'`))
      .orderBy(asc(assets.createdAt))
      .limit(1);
    [a] = await ctx.db.update(assets).set({ originalSha256: sha, duplicateOf: dup?.id ?? null }).where(eq(assets.id, a.id)).returning() as [Asset];
  }

  const force = (job.params as { force?: boolean } | null)?.force === true;
  const outcome = a.kind === 'image' ? await processImage(ctx, job.id, a, src, scope, force) : await processVideo(ctx, job, a, src, scope);
  // Core originals are sealed once their outputs exist (and unsealed again if the item moved to member tier).
  await reconcileOriginal(ctx, a.id);
  return outcome;
}
