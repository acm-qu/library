import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { type Asset, assets } from '@acm/core/db';
import { tmpDir } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { type Ctx, type JobScope, Permanent } from '../context.ts';
import { ChildFailed, mediaworker } from '../lib/spawn.ts';
import { getOrCreateKeys } from '../lib/keys.ts';
import { sealAll, wantsEncryption } from '../lib/seal.ts';
import { publish, type Out } from './publish.ts';

type FileOut = { file: string; width: number; height: number; bytes: number };
type ImagesResult =
  | { needs_review: string; width: number; height: number }
  | { width: number; height: number; captured_at: string | null; device: string | null; files: { view: FileOut; thumb: FileOut } };

export async function processImage(ctx: Ctx, jobId: string, a: Asset, src: string, scope: JobScope, force = false): Promise<'ok' | 'needs_review'> {
  const tmp = tmpDir(ctx.cfg.MEDIA_ROOT, jobId);
  const out = path.join(tmp, 'out'); // tmp/ also holds a decrypted source for core re-processing
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  try {
    await scope.step('Making previews', 0.2);
    let r: ImagesResult;
    try {
      r = await mediaworker<ImagesResult>(ctx.cfg.PYTHON, ['images', '--src', src, '--out', out, ...(force ? ['--allow-hdr'] : [])], { timeoutMs: 180_000 });
    } catch (e) {
      // Pillow can't open it: the file is truncated or not really an image. Retrying won't help.
      if (e instanceof ChildFailed && ['UnidentifiedImageError', 'OSError', 'DecompressionBombError', 'SyntaxError'].includes(e.code)) throw new Permanent('decode_failed', e.message);
      throw e;
    }
    if ('needs_review' in r) {
      await ctx.db.update(assets).set({ status: 'needs_review', reviewReason: r.needs_review, width: r.width, height: r.height, updatedAt: new Date() }).where(eq(assets.id, a.id));
      return 'needs_review';
    }
    await scope.throwIfCancelled();
    let outs: Out[] = [
      { kind: 'image_view', ...r.files.view },
      { kind: 'image_thumb', ...r.files.thumb },
    ];
    if (wantsEncryption(a)) {
      const { fileKey } = await getOrCreateKeys(ctx, a.id);
      const sealed = await sealAll(out, outs.map((o) => o.file), fileKey, a.id);
      outs = await Promise.all(outs.map(async (o, i) => ({ ...o, file: sealed[i]!, encrypted: true, bytes: (await stat(path.join(out, sealed[i]!))).size })));
    }
    await publish(ctx, a, out, outs, {
      width: r.width,
      height: r.height,
      capturedAt: r.captured_at ? new Date(r.captured_at) : a.capturedAt,
      device: r.device ?? a.device,
      reviewReason: null,
    });
    return 'ok';
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
