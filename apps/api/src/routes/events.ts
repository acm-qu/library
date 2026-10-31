import { assets, type Db, events, jobs } from '@acm/core/db';
import { eventSearchQuery } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { CreateEventBody, type EventDetail, EventListQuery, Id, PatchEventBody, type Viewer } from '@acm/core/schemas';
import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readerOf, requireAdmin, requireCore, viewerOf } from '../auth/plugin.ts';
import { audit } from '../lib/audit.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { mediaUrl } from '../lib/dto.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { baseSlug, withSuffix } from '../lib/slug.ts';
import { seesGirlsOnly } from '../policy/canView.ts';
import { browsable, girlsOk } from '../policy/visibleSql.ts';

const EventCursor = z.object({ s: z.string(), i: z.string() });

type Row = {
  id: string;
  slug: string;
  title: string;
  starts_on: string;
  ends_on: string | null;
  location: string | null;
  description: string | null;
  default_tier: 'member' | 'core';
  cover_asset_id: string | null;
  photo_count: number;
  video_count: number;
  core_count: number;
  cover_id: string | null;
  cover_rev: number | null;
};

/**
 * Events with per-viewer counts and cover. Members only see public events that contain something they can see;
 * core members see every event, including empty ones they may upload to, except one holding only girls-only
 * items they may not see.
 */
async function queryEvents(db: Db, v: Viewer, where: SQL[], limit: number): Promise<Row[]> {
  const vis = browsable(v);
  const visible = sql`(c.photo_count + c.video_count) > 0`;
  const hiddenGirls = sql`exists (select 1 from ${assets} where ${assets.eventId} = events.id and ${assets.deletedAt} is null and ${assets.girlsOnly})`;
  const memberFilter = v.role !== 'core' ? sql`(${visible} and events.default_tier = 'member')` : seesGirlsOnly(v) ? sql`true` : sql`(${visible} or not ${hiddenGirls})`;
  const res = await db.execute<Row>(sql`
    select events.id, events.slug, events.title, events.starts_on::text as starts_on, events.ends_on::text as ends_on, events.location, events.description,
           events.default_tier, events.cover_asset_id, c.photo_count, c.video_count, c.core_count, cov.id as cover_id, cov.rendition_rev as cover_rev
    from ${events}
    cross join lateral (
      select count(*) filter (where ${assets.kind} = 'image')::int as photo_count,
             count(*) filter (where ${assets.kind} = 'video')::int as video_count,
             count(*) filter (where ${assets.tier} = 'core')::int as core_count
      from ${assets} where ${assets.eventId} = events.id and ${vis}
    ) c
    left join lateral (
      select ${assets.id} as id, ${assets.renditionRev} as rendition_rev from ${assets}
      where ${assets.eventId} = events.id and ${vis} and ${assets.status} = 'ready'
      order by (${assets.id} = events.cover_asset_id) desc, (${assets.kind} = 'image') desc,
               coalesce(${assets.capturedAt}, ${assets.createdAt}), ${assets.id}
      limit 1
    ) cov on true
    where events.deleted_at is null and ${memberFilter} ${sql.join(where.map((w) => sql` and ${w}`))}
    order by events.starts_on desc, events.id desc
    limit ${limit}`);
  return res.rows;
}

function toDetail(r: Row): EventDetail {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    location: r.location,
    description: r.description,
    defaultTier: r.default_tier,
    // Only when the viewer can see the cover; a hidden core cover must not reveal that the item exists.
    coverAssetId: r.cover_id === r.cover_asset_id ? r.cover_asset_id : null,
    photoCount: r.photo_count,
    videoCount: r.video_count,
    coverUrl: r.cover_id ? mediaUrl(r.cover_id, 'thumb', r.cover_rev ?? 0) : null,
    hasCore: r.core_count > 0,
  };
}
const toCard = ({ description: _d, defaultTier: _t, coverAssetId: _c, ...card }: EventDetail) => card;

const byIdOrSlug = (idOrSlug: string) => (Id.safeParse(idOrSlug).success ? sql`events.id = ${idOrSlug}` : sql`events.slug = ${idOrSlug}`);

export async function findVisibleEvent(db: Db, v: Viewer, idOrSlug: string): Promise<EventDetail> {
  const [row] = await queryEvents(db, v, [byIdOrSlug(idOrSlug)], 1);
  if (!row) throw notFound();
  return toDetail(row);
}

export function eventRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.get('/api/events', async (req) => {
    const v = readerOf(req);
    const qry = EventListQuery.parse(req.query);
    const where: SQL[] = [];
    if (qry.q) {
      const search = eventSearchQuery(qry.q);
      if (search) where.push(search);
    }
    if (qry.year) where.push(sql`extract(year from events.starts_on) = ${qry.year}`);
    if (qry.hasVideos) where.push(sql`c.video_count > 0`);
    const cur = decodeCursor(EventCursor, qry.cursor);
    if (cur) where.push(sql`(events.starts_on, events.id) < (${cur.s}::date, ${cur.i}::uuid)`);
    const rows = await queryEvents(db, v, where, qry.limit + 1);
    const page = rows.slice(0, qry.limit);
    const last = page.at(-1);
    return {
      items: page.map((r) => toCard(toDetail(r))),
      nextCursor: rows.length > qry.limit && last ? encodeCursor({ s: last.starts_on, i: last.id }) : null,
    };
  });

  /** Distinct years that have visible events, for the year filter. */
  app.get('/api/events/years', async (req) => {
    const rows = await queryEvents(db, readerOf(req), [], 10_000);
    return { years: [...new Set(rows.map((r) => Number(r.starts_on.slice(0, 4))))] };
  });

  app.get('/api/events/:idOrSlug', async (req) => {
    const { idOrSlug } = z.object({ idOrSlug: z.string().max(200) }).parse(req.params);
    return findVisibleEvent(db, readerOf(req), idOrSlug);
  });

  app.post('/api/events', { preHandler: requireCore }, async (req, reply) => {
    const v = viewerOf(req);
    const body = CreateEventBody.parse(req.body);
    const id = newId();
    const base = baseSlug(body.title, body.startsOn, id);
    for (let n = 1; ; n++) {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(events).values({ id, slug: withSuffix(base, n), ...body, endsOn: body.endsOn ?? null, location: body.location ?? null, description: body.description ?? null, createdBy: v.id });
          await audit(tx, v.id, 'event.create', { type: 'event', id }, { title: body.title });
        });
        break;
      } catch (e) {
        if ((e as { cause?: { code?: string } }).cause?.code !== '23505' || n > 50) throw e;
      }
    }
    return reply.code(201).send(await findVisibleEvent(db, v, id));
  });

  app.patch('/api/events/:id', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: Id }).parse(req.params);
    const body = PatchEventBody.parse(req.body);
    const [ev] = await db.select().from(events).where(and(eq(events.id, id), isNull(events.deletedAt)));
    if (!ev) throw notFound();
    await findVisibleEvent(db, v, id); // an event hidden from this viewer (only girls-only items) is a 404 here too
    const startsOn = body.startsOn ?? ev.startsOn;
    const endsOn = body.endsOn === undefined ? ev.endsOn : body.endsOn;
    if (endsOn && endsOn < startsOn) throw new HttpError('bad_request', { fields: { endsOn: 'ends_before_start' } });
    if (body.coverAssetId) {
      const [cover] = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.id, body.coverAssetId), eq(assets.eventId, id), eq(assets.status, 'ready'), isNull(assets.deletedAt), girlsOk(v)));
      if (!cover) throw new HttpError('bad_request', { fields: { coverAssetId: 'not_a_ready_item_of_this_event' } });
    }
    await db.transaction(async (tx) => {
      await tx.update(events).set({ ...body, updatedAt: new Date() }).where(eq(events.id, id));
      // Everything in a core-only event is core: saving it as core raises any public items, each re-sealed by a job.
      const raised =
        body.defaultTier === 'core'
          ? await tx
              .update(assets)
              .set({ tier: 'core', updatedAt: new Date() })
              .where(and(eq(assets.eventId, id), eq(assets.tier, 'member'), isNull(assets.deletedAt), ne(assets.status, 'deleting')))
              .returning({ id: assets.id, kind: assets.kind, status: assets.status })
          : [];
      if (raised.length) await tx.insert(jobs).values(raised.map((a) => ({ id: newId(), assetId: a.id, kind: a.kind === 'video' && a.status === 'ready' ? ('reprocess' as const) : ('retier' as const), priority: 100 })));
      await audit(tx, v.id, 'event.update', { type: 'event', id }, raised.length ? { ...body, raised: raised.length } : body);
    });
    return findVisibleEvent(db, v, id);
  });

  app.delete('/api/events/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: Id }).parse(req.params);
    await findVisibleEvent(db, v, id); // same 404 as the page for an event this admin can't see
    // Deleting an event deletes everything in it, so items this admin can't see (girls-only) need an admin who can.
    if (!seesGirlsOnly(v)) {
      const [hidden] = await db.select({ id: assets.id }).from(assets).where(and(eq(assets.eventId, id), eq(assets.girlsOnly, true), isNull(assets.deletedAt))).limit(1);
      if (hidden) throw new HttpError('not_allowed', {}, 'This event has girls-only items, so a female admin has to delete it.');
    }
    await db.transaction(async (tx) => {
      const [ev] = await tx.update(events).set({ deletedAt: new Date() }).where(and(eq(events.id, id), isNull(events.deletedAt))).returning({ id: events.id });
      if (!ev) throw notFound();
      const doomed = await tx
        .update(assets)
        .set({ status: 'deleting', updatedAt: new Date() })
        .where(and(eq(assets.eventId, id), isNull(assets.deletedAt)))
        .returning({ id: assets.id });
      if (doomed.length) await tx.insert(jobs).values(doomed.map((a) => ({ id: newId(), assetId: a.id, kind: 'purge' as const, priority: 100 })));
      await audit(tx, v.id, 'event.delete', { type: 'event', id }, { assets: doomed.length });
    });
    return reply.code(204).send();
  });
}
