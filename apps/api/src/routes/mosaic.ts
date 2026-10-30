// The sign-in page's mosaic: a few public photo thumbnails, inlined as data: URLs so the page makes one request for
// all of them. Only ready, public, non-girls-only photos in live events. Built at most every 10 minutes.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '@acm/core/config';
import { assets, type Db, events, renditions } from '@acm/core/db';
import { assetDir } from '@acm/core/paths';
import type { LoginMosaic } from '@acm/core/schemas';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export const MOSAIC_SIZE = 6;
const TTL_MS = 10 * 60_000;

export async function buildMosaic(db: Db, mediaRoot: string): Promise<LoginMosaic> {
  const rows = await db
    .select({ id: assets.id, relPath: renditions.relPath, width: renditions.width, height: renditions.height })
    .from(assets)
    .innerJoin(events, eq(events.id, assets.eventId))
    .innerJoin(renditions, and(eq(renditions.assetId, assets.id), eq(renditions.kind, 'image_thumb'), eq(renditions.encrypted, false)))
    .where(and(eq(assets.kind, 'image'), eq(assets.tier, 'member'), eq(assets.status, 'ready'), eq(assets.girlsOnly, false), isNull(assets.deletedAt), isNull(events.deletedAt)))
    .orderBy(sql`random()`)
    .limit(MOSAIC_SIZE);
  const images = await Promise.all(
    rows.map(async (r) => {
      const bytes = await readFile(path.join(assetDir(mediaRoot, r.id), r.relPath)).catch(() => null);
      return bytes && { src: `data:image/webp;base64,${bytes.toString('base64')}`, width: r.width ?? 0, height: r.height ?? 0 };
    }),
  );
  return { images: images.filter((i) => i !== null) };
}

export function mosaicRoutes(app: FastifyInstance, { db, cfg }: { db: Db; cfg: ServerConfig }) {
  let cached: { at: number; body: LoginMosaic } | null = null;
  app.get('/api/public/login-mosaic', async (_req, reply) => {
    if (!cached || Date.now() - cached.at > TTL_MS) cached = { at: Date.now(), body: await buildMosaic(db, cfg.MEDIA_ROOT) };
    return reply.header('Cache-Control', 'public, max-age=600').send(cached.body);
  });
}
