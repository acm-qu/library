// Hourly housekeeping (cron): abandoned uploads, stale queue tickets, expired sessions and codes, worker scratch left by a crash.
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assets, expireUploadTickets, jobs, otpCodes, sessions } from '@acm/core/db';
import { tusDir } from '@acm/core/paths';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Ctx } from './context.ts';

export const ABANDON_AFTER_MS = 48 * 3600_000;

export async function cleanup(ctx: Ctx, now = Date.now()) {
  const cutoff = new Date(now - ABANDON_AFTER_MS);
  const abandoned = await ctx.db.delete(assets).where(and(eq(assets.status, 'uploading'), lt(assets.createdAt, cutoff))).returning({ uploadId: assets.uploadId });
  for (const a of abandoned) {
    if (!a.uploadId || !/^[\w-]+$/.test(a.uploadId)) continue;
    await rm(path.join(tusDir(ctx.cfg.MEDIA_ROOT), a.uploadId), { force: true });
    await rm(path.join(tusDir(ctx.cfg.MEDIA_ROOT), `${a.uploadId}.json`), { force: true });
  }
  // tus files with no row at all (e.g. the row was cleaned while a file lingered).
  const orphans = await sweepDir(tusDir(ctx.cfg.MEDIA_ROOT), cutoff.getTime());
  // The API expires tickets on every grant pass; this catches the ones left when nobody uploads for a while.
  const tickets = await expireUploadTickets(ctx.db);
  const s = await ctx.db.delete(sessions).where(lt(sessions.expiresAt, new Date(now))).returning({ id: sessions.id });
  const o = await ctx.db.delete(otpCodes).where(lt(otpCodes.expiresAt, new Date(now - 24 * 3600_000))).returning({ id: otpCodes.id });
  // Scratch dirs belong to jobs; anything not for a running job is left over from a crash.
  const running = new Set((await ctx.db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.state, ['running']))).map((j) => j.id));
  let scratch = 0;
  const tmp = path.join(ctx.cfg.MEDIA_ROOT, 'tmp');
  for (const d of await readdir(tmp).catch(() => [] as string[])) {
    if (running.has(d)) continue;
    await rm(path.join(tmp, d), { recursive: true, force: true });
    scratch++;
  }
  const result = { abandoned: abandoned.length, orphans, tickets, sessions: s.length, codes: o.length, scratch };
  ctx.log.info(result, 'cleanup');
  return result;
}

async function sweepDir(dir: string, olderThan: number) {
  let n = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, f);
    const st = await stat(p).catch(() => null);
    if (st?.isFile() && st.mtimeMs < olderThan) {
      await rm(p, { force: true });
      n++;
    }
  }
  return n;
}
