import { assets, type Db, events, jobs, renditions, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { type AssetDetail, AssetListQuery, Id, PatchAssetBody, type Viewer } from '@acm/core/schemas';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readerOf, requireAdmin, requireCore, viewerOf } from '../auth/plugin.ts';
import { audit } from '../lib/audit.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { downloadName, mediaUrl, toTile } from '../lib/dto.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { activeJobs, byAsset } from '../lib/queue.ts';
import { access, atLeast, canEditAsset } from '../policy/canView.ts';
import { listed } from '../policy/visibleSql.ts';
import { findVisibleEvent } from './events.ts';

const AssetCursor = z.object({ t: z.string(), i: z.string() });
const SORT_TIME = sql`coalesce(${assets.capturedAt}, ${assets.createdAt})`;

/** The asset plus whether its event is deleted; 404 unless the viewer reaches `min`. */
export async function loadAsset(db: Db, v: Viewer, id: string, min: 'status' | 'download' | 'full') {
  if (!Id.safeParse(id).success) throw notFound();
  const [row] = await db
    .select({ asset: assets, eventDeleted: sql<boolean>`${events.deletedAt} is not null` })
    .from(assets)
    .innerJoin(events, eq(events.id, assets.eventId))
    .where(eq(assets.id, id));
  if (!row || !atLeast(access(v, row.asset, row.eventDeleted), min)) throw notFound();
  return row.asset;
}

export function assetRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/events/:id/assets', async (req) => {
    const v = readerOf(req);
    const { id: idOrSlug } = z.object({ id: z.string().max(200) }).parse(req.params);
    const qry = AssetListQuery.parse(req.query);
    const ev = await findVisibleEvent(db, v, idOrSlug);
    const where: SQL[] = [eq(assets.eventId, ev.id), listed(v)];
    if (qry.kind) where.push(eq(assets.kind, qry.kind));
    if (qry.tier && v.role === 'core') where.push(eq(assets.tier, qry.tier));
    const cur = decodeCursor(AssetCursor, qry.cursor);
    if (cur) where.push(sql`(${SORT_TIME}, ${assets.id}) > (${cur.t}::timestamptz, ${cur.i}::uuid)`);
    const rows = await db
      .select({ a: assets, t: sql<string>`to_char(${SORT_TIME} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(assets)
      .where(and(...where))
      .orderBy(asc(SORT_TIME), asc(assets.id))
      .limit(qry.limit + 1);
    const page = rows.slice(0, qry.limit);
    const jobsByAsset = page.some((r) => r.a.status !== 'ready' || v.role === 'core') ? byAsset(await activeJobs(db)) : new Map();
    const last = page.at(-1);
    return {
      items: page.map((r) => toTile(v, r.a, jobsByAsset.get(r.a.id))),
      nextCursor: rows.length > qry.limit && last ? encodeCursor({ t: last.t, i: last.a.id }) : null,
    };
  });

  app.get('/api/assets/:id', async (req): Promise<AssetDetail> => {
    const v = readerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const a = await loadAsset(db, v, id, 'status');
    const level = access(v, a);
    const [rends, [uploader], jobsList] = await Promise.all([
      db.select().from(renditions).where(eq(renditions.assetId, a.id)),
      db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, a.uploaderId)),
      db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.assetId, a.id), sql`${jobs.state} in ('queued','running')`)).limit(1),
    ]);
    const job = jobsList.length ? byAsset(await activeJobs(db)).get(a.id) : undefined;
    const full = atLeast(level, 'full');
    const has = (kind: string) => rends.some((r) => r.kind === kind);
    return {
      ...toTile(v, a, job),
      eventId: a.eventId,
      originalFilename: a.originalFilename,
      originalMime: a.originalMime,
      originalSize: a.originalSize,
      downloadName: downloadName(a),
      capturedAt: a.capturedAt?.toISOString() ?? null,
      device: a.device,
      fps: a.fps,
      uploader: uploader && req.viewer ? { id: uploader.id, name: uploader.name || uploader.email.split('@')[0]! } : null,
      viewUrl: full && a.kind === 'image' && has('image_view') ? mediaUrl(a.id, 'view', a.renditionRev) : null,
      posterUrl: full && a.kind === 'video' && has('video_poster') ? mediaUrl(a.id, 'poster', a.renditionRev) : null,
      hlsUrl: full && a.kind === 'video' && has('hls_master') ? `/api/media/${a.id}/hls/master.m3u8?v=${a.renditionRev}` : null,
      originalUrl: atLeast(level, 'download') ? `/api/media/${a.id}/original` : null,
      variants: rends
        .filter((r) => r.kind === 'hls_variant')
        .map((r) => ({ label: r.label, height: r.height ?? 0, bandwidth: r.bandwidth ?? 0 }))
        .sort((x, y) => x.height - y.height),
      canEdit: canEditAsset(v, a),
      canDelete: v.isAdmin,
    };
  });

  app.patch('/api/assets/:id', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = PatchAssetBody.parse(req.body);
    const a = await loadAsset(db, v, id, 'status');
    if (!canEditAsset(v, a)) throw notFound();
    if (body.eventId && body.eventId !== a.eventId) {
      const [target] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, body.eventId), isNull(events.deletedAt)));
      if (!target) throw new HttpError('bad_request', { fields: { eventId: 'no_such_event' } });
    }
    await db.transaction(async (tx) => {
      // Access follows the tier column at once; a job then re-seals (or unseals) the stored bytes to match.
      await tx.update(assets).set({ ...body, updatedAt: new Date() }).where(eq(assets.id, a.id));
      if (body.tier && body.tier !== a.tier) {
        await audit(tx, v.id, 'asset.tier', { type: 'asset', id: a.id }, { from: a.tier, to: body.tier });
        await tx.insert(jobs).values({ id: newId(), assetId: a.id, kind: a.kind === 'video' && a.status === 'ready' ? 'reprocess' : 'retier', priority: 100 });
      }
      if (body.girlsOnly !== undefined && body.girlsOnly !== a.girlsOnly) {
        await audit(tx, v.id, 'asset.girls_only', { type: 'asset', id: a.id }, { from: a.girlsOnly, to: body.girlsOnly });
      }
      if (body.eventId && body.eventId !== a.eventId) {
        await audit(tx, v.id, 'asset.move', { type: 'asset', id: a.id }, { from: a.eventId, to: body.eventId });
        await tx.update(events).set({ coverAssetId: null }).where(and(eq(events.id, a.eventId), eq(events.coverAssetId, a.id)));
      }
    });
    return { ok: true };
  });

  app.delete('/api/assets/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const a = await loadAsset(db, v, id, 'status'); // admins reach 'status' on every live item
    await db.transaction(async (tx) => {
      await tx.update(assets).set({ status: 'deleting', updatedAt: new Date() }).where(eq(assets.id, a.id));
      await tx.update(jobs).set({ state: 'cancelled', finishedAt: new Date() }).where(and(eq(jobs.assetId, a.id), eq(jobs.state, 'queued')));
      await tx.insert(jobs).values({ id: newId(), assetId: a.id, kind: 'purge', priority: 100 });
      await tx.update(events).set({ coverAssetId: null }).where(eq(events.coverAssetId, a.id));
      await audit(tx, v.id, 'asset.delete', { type: 'asset', id: a.id }, { filename: a.originalFilename });
    });
    return reply.code(204).send();
  });
}
