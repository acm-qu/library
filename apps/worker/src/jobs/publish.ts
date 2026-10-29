// Atomic rendition swap: outputs are built in tmp/<job>/, renamed to r<rev+1>/, and the rendition rows plus
// assets.rendition_rev change in one transaction. Viewers keep the old outputs until that commit; the old
// directory is removed afterwards.
import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { appSettings, type Asset, assets, renditions, type RenditionKind } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { assetDir, revDir } from '@acm/core/paths';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.ts';

export type Out = { kind: RenditionKind; file: string; label?: string; width?: number | null; height?: number | null; bandwidth?: number | null; bytes: number; encrypted?: boolean };

export async function settingsVersion(ctx: Ctx) {
  const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, 'settings_version'));
  return typeof row?.value === 'number' ? row.value : 1;
}

export async function publish(ctx: Ctx, a: Asset, tmp: string, outs: Out[], patch: Partial<typeof assets.$inferInsert>) {
  const rev = a.renditionRev + 1;
  const dest = revDir(ctx.cfg.MEDIA_ROOT, a.id, rev);
  await rm(dest, { recursive: true, force: true });
  await rename(tmp, dest);
  const sv = await settingsVersion(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.delete(renditions).where(eq(renditions.assetId, a.id));
    if (outs.length)
      await tx.insert(renditions).values(
        outs.map((o) => ({
          id: newId(),
          assetId: a.id,
          kind: o.kind,
          label: o.label ?? '',
          width: o.width ?? null,
          height: o.height ?? null,
          bandwidth: o.bandwidth ?? null,
          bytes: o.bytes,
          relPath: `r${rev}/${o.file}`,
          encrypted: o.encrypted ?? false,
          settingsVersion: sv,
        })),
      );
    await tx.update(assets).set({ ...patch, status: 'ready', renditionRev: rev, updatedAt: new Date() }).where(eq(assets.id, a.id));
  });
  // Older revisions are unreachable now.
  for (const d of await readdir(assetDir(ctx.cfg.MEDIA_ROOT, a.id))) {
    if (/^r\d+$/.test(d) && d !== `r${rev}`) await rm(path.join(assetDir(ctx.cfg.MEDIA_ROOT, a.id), d), { recursive: true, force: true });
  }
  return rev;
}
