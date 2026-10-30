// Encryption state of an asset's files follows its tier: core → sealed (.enc), member → plaintext.
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { type Asset, assets } from '@acm/core/db';
import { openFileTo, sealFile } from '@acm/core/crypto';
import { originalPath, tmpDir } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';
import { deleteKeys, getKeys, getOrCreateKeys } from './keys.ts';
import { pacer } from './pace.ts';

export const wantsEncryption = (a: Pick<Asset, 'tier'>) => a.tier === 'core';

/** Seal every listed file in `dir` in place (x → x.enc). Returns the new names. */
export async function sealAll(dir: string, files: string[], fileKey: Buffer, assetId: string) {
  const out: string[] = [];
  for (const f of files) {
    const plain = path.join(dir, f);
    await sealFile(plain, `${plain}.enc`, fileKey, assetId, undefined, pacer());
    await rm(plain);
    out.push(`${f}.enc`);
  }
  return out;
}

/**
 * A plaintext copy of the original for this job: the original itself when it is plaintext, or a decrypted copy
 * in the job's tmp/ (removed with tmp/ when the job ends).
 */
export async function plainOriginal(ctx: Ctx, a: Asset, jobId: string): Promise<string> {
  if (!a.encrypted) return originalPath(ctx.cfg.MEDIA_ROOT, a.id, a.originalExt, false);
  const keys = await getKeys(ctx, a.id);
  if (!keys) throw new Error('encrypted original without keys');
  const dst = path.join(tmpDir(ctx.cfg.MEDIA_ROOT, jobId), `src.${a.originalExt}`);
  await rm(dst, { force: true });
  await openFileTo(originalPath(ctx.cfg.MEDIA_ROOT, a.id, a.originalExt, true), dst, keys.fileKey, a.id, pacer());
  return dst;
}

/** Bring the original's encryption in line with the tier. Run after outputs are published. */
export async function reconcileOriginal(ctx: Ctx, assetId: string) {
  const [a] = await ctx.db.select().from(assets).where(eq(assets.id, assetId));
  if (!a) return;
  const plain = originalPath(ctx.cfg.MEDIA_ROOT, a.id, a.originalExt, false);
  const sealed = originalPath(ctx.cfg.MEDIA_ROOT, a.id, a.originalExt, true);
  if (wantsEncryption(a) && !a.encrypted) {
    const keys = await getOrCreateKeys(ctx, a.id);
    await rm(`${sealed}.part`, { force: true });
    await sealFile(plain, `${sealed}.part`, keys.fileKey, a.id, undefined, pacer());
    await rename(`${sealed}.part`, sealed);
    await ctx.db.update(assets).set({ encrypted: true }).where(eq(assets.id, a.id));
    await rm(plain);
  } else if (!wantsEncryption(a) && a.encrypted) {
    const keys = await getKeys(ctx, a.id);
    if (!keys) throw new Error('encrypted original without keys');
    await rm(`${plain}.part`, { force: true });
    await openFileTo(sealed, `${plain}.part`, keys.fileKey, a.id, pacer());
    await rename(`${plain}.part`, plain);
    await ctx.db.update(assets).set({ encrypted: false }).where(eq(assets.id, a.id));
    await rm(sealed);
    await deleteKeys(ctx, a.id);
  }
}
