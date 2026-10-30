// Storage stats (nightly cron, and after any worker pass that ran jobs): bytes and file count under MEDIA_ROOT, kept in app_settings for Admin · Storage.
// Counting files on every page view would walk the whole tree; only passes that changed files re-walk it.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { appSettings } from '@acm/core/db';
import { eq } from 'drizzle-orm';
import type { Ctx } from './context.ts';

async function walk(dir: string, onFile: (p: string, size: number) => void) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, onFile);
    else if (e.isFile()) onFile(p, (await stat(p)).size);
  }
}

export async function storageStats(ctx: Ctx, now = new Date()) {
  let bytesOriginals = 0;
  let bytesRenditions = 0;
  let files = 0;
  const byKind = { originals: 0, photoCopies: 0, videoFiles: 0, other: 0 };
  await walk(ctx.cfg.MEDIA_ROOT, (p, size) => {
    files++;
    if (/[\\/]original\.[^\\/]+$/.test(p)) {
      bytesOriginals += size;
      byKind.originals++;
    } else {
      bytesRenditions += size;
      if (/[\\/]hls[\\/]/.test(p)) byKind.videoFiles++; // playlists and data.ts
      else if (/[\\/]r\d+[\\/]/.test(p)) byKind.photoCopies++; // view, thumb, poster
      else byKind.other++;
    }
  });
  const at = now.toISOString();
  const stats = { at, bytesOriginals, bytesRenditions, files, byKind };
  const [row] = await ctx.db.select().from(appSettings).where(eq(appSettings.key, 'storage_history'));
  const history = (Array.isArray(row?.value) ? row.value : []) as { date: string; bytes: number; files: number }[];
  const date = at.slice(0, 10);
  const next = [...history.filter((h) => h.date !== date), { date, bytes: bytesOriginals + bytesRenditions, files }].slice(-365);
  for (const [key, value] of [['storage_stats', stats], ['storage_history', next]] as const)
    await ctx.db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });
  ctx.log.info(stats, 'storage stats');
  return stats;
}
