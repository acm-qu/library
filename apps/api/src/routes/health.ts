import { statfs } from 'node:fs/promises';
import type { ServerConfig } from '@acm/core/config';
import { appSettings, type Db } from '@acm/core/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/** For the health cron: DB ping, free disk under MEDIA_ROOT, and the worker's last tick. 503 if the DB is down. */
export function healthRoutes(app: FastifyInstance, { db, cfg }: { db: Db; cfg: ServerConfig }) {
  app.get('/api/health', async (_req, reply) => {
    let dbOk = false;
    let workerTick: string | null = null;
    try {
      await db.execute(sql`select 1`);
      dbOk = true;
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, 'worker_tick'));
      workerTick = typeof row?.value === 'string' ? row.value : null;
    } catch {
      /* reported below */
    }
    const disk = await statfs(cfg.MEDIA_ROOT).catch(() => null);
    const body = { ok: dbOk, db: dbOk, release: process.env.ACM_RELEASE ?? 'dev', diskFreeBytes: disk ? disk.bavail * disk.bsize : null, workerTick };
    return reply.code(dbOk ? 200 : 503).header('Cache-Control', 'no-store').send(body);
  });
}
