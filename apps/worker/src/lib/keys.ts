// Per-asset keys: a 32-byte file key (ACMENC01) and a 16-byte HLS key (AES-128), wrapped under MASTER_KEY.
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { assetKeys } from '@acm/core/db';
import { KEY_BYTES, parseMasterKey, randomKey, unwrapKey, wrapKey } from '@acm/core/crypto';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';

export type Keys = { fileKey: Buffer; hlsKey: Buffer };

export async function getKeys(ctx: Ctx, assetId: string): Promise<Keys | null> {
  const [row] = await ctx.db.select().from(assetKeys).where(eq(assetKeys.assetId, assetId));
  if (!row) return null;
  const master = parseMasterKey(ctx.cfg.MASTER_KEY);
  return { fileKey: unwrapKey(row.fileKeyWrapped, master), hlsKey: row.hlsKeyWrapped ? unwrapKey(row.hlsKeyWrapped, master) : randomKey(16) };
}

export async function getOrCreateKeys(ctx: Ctx, assetId: string): Promise<Keys> {
  const existing = await getKeys(ctx, assetId);
  if (existing) return existing;
  const master = parseMasterKey(ctx.cfg.MASTER_KEY);
  const keys = { fileKey: randomKey(KEY_BYTES), hlsKey: randomKey(16) };
  await ctx.db
    .insert(assetKeys)
    .values({ assetId, fileKeyWrapped: wrapKey(keys.fileKey, master), hlsKeyWrapped: wrapKey(keys.hlsKey, master) })
    .onConflictDoNothing();
  return (await getKeys(ctx, assetId))!;
}

export const deleteKeys = (ctx: Ctx, assetId: string) => ctx.db.delete(assetKeys).where(eq(assetKeys.assetId, assetId));

/**
 * ffmpeg's -hls_key_info_file: line 1 is the URI written into the playlists, line 2 the key file. Both live in
 * KEYS_DIR (outside the web root, 700) only for the duration of the encode.
 */
export async function writeKeyInfo(ctx: Ctx, jobId: string, assetId: string, hlsKey: Buffer) {
  const keyFile = path.join(ctx.cfg.KEYS_DIR, `${jobId}.key`);
  const info = path.join(ctx.cfg.KEYS_DIR, `${jobId}.keyinfo`);
  await writeFile(keyFile, hlsKey, { mode: 0o600 });
  await writeFile(info, `/api/media/${assetId}/hls/key\n${keyFile}\n`, { mode: 0o600 });
  return {
    info,
    cleanup: async () => {
      await rm(keyFile, { force: true });
      await rm(info, { force: true });
    },
  };
}
