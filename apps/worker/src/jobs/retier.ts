// Tier change on a ready image: re-seal (member → core) or unseal (core → member) the renditions into a new
// revision and the original, without re-rendering. Access already follows the tier column; this only changes
// how the bytes are stored. Videos are re-processed instead, because segment encryption happens at encode time.
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assets, type Job, renditions } from '@acm/core/db';
import { openFileTo, sealFile } from '@acm/core/crypto';
import { assetDir, tmpDir } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import { type Ctx, Permanent } from '../context.ts';
import { getKeys, getOrCreateKeys } from '../lib/keys.ts';
import { pacer } from '../lib/pace.ts';
import { reconcileOriginal, wantsEncryption } from '../lib/seal.ts';
import { type Out, publish } from './publish.ts';

export async function runRetier(ctx: Ctx, job: Job): Promise<'ok'> {
  if (!job.assetId) throw new Permanent('no_asset');
  const [a] = await ctx.db.select().from(assets).where(eq(assets.id, job.assetId));
  if (!a || a.deletedAt || a.status === 'deleting') return 'ok';
  if (a.status !== 'ready' && a.status !== 'original_only') {
    await reconcileOriginal(ctx, a.id);
    return 'ok';
  }
  const encrypt = wantsEncryption(a);
  const rs = await ctx.db.select().from(renditions).where(eq(renditions.assetId, a.id));
  if (rs.every((r) => r.encrypted === encrypt) && a.encrypted === encrypt) return 'ok';

  const out = path.join(tmpDir(ctx.cfg.MEDIA_ROOT, job.id), 'out');
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  try {
    const keys = encrypt ? await getOrCreateKeys(ctx, a.id) : await getKeys(ctx, a.id);
    const outs: Out[] = [];
    for (const r of rs) {
      const from = path.join(assetDir(ctx.cfg.MEDIA_ROOT, a.id), r.relPath);
      const base = path.basename(r.relPath).replace(/\.enc$/, '');
      const name = encrypt ? `${base}.enc` : base;
      const to = path.join(out, name);
      if (r.encrypted === encrypt) await copyFile(from, to);
      else if (encrypt) await sealFile(from, to, keys!.fileKey, a.id, undefined, pacer());
      else await openFileTo(from, to, keys!.fileKey, a.id, pacer());
      outs.push({ kind: r.kind, file: name, label: r.label, width: r.width, height: r.height, bandwidth: r.bandwidth, bytes: (await stat(to)).size, encrypted: encrypt });
    }
    await publish(ctx, a, out, outs, {});
    if (a.status === 'original_only') await ctx.db.update(assets).set({ status: 'original_only' }).where(eq(assets.id, a.id));
    await reconcileOriginal(ctx, a.id);
    return 'ok';
  } finally {
    await rm(tmpDir(ctx.cfg.MEDIA_ROOT, job.id), { recursive: true, force: true });
  }
}
