// tus endpoint (resumable uploads), My uploads and Retry.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ServerConfig } from '@acm/core/config';
import { assets, type Db, events, jobs, uploadTickets, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { tusDir } from '@acm/core/paths';
import { type MyUploadItem, MyUploadsQuery, UploadMetadata, type UploadQueue, UploadTicketBody } from '@acm/core/schemas';
import { FileStore } from '@tus/file-store';
import { EVENTS, Server } from '@tus/server';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireCore, viewerOf } from '../auth/plugin.ts';
import { audit } from '../lib/audit.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { makeLimiter } from '../lib/limits.ts';
import { activeJobs, byAsset } from '../lib/queue.ts';
import { ingest, UnsupportedType } from '../uploads/ingest.ts';
import { wakeWorker } from '../lib/wake.ts';
import { ioRates, paced, takeUpload } from '../media/throttle.ts';
import { grantTickets, MAX_UPLOAD_SLOTS, releaseUpload, ticketState } from '../uploads/tickets.ts';
import { girlsOk } from '../policy/visibleSql.ts';

/** Set by Fastify after auth and overwritten on every request, so a client can never supply it. */
const USER_HEADER = 'x-acm-uploader';
/** Every tus request from the browser names its granted queue ticket; PATCHes without a live one get 409 no_slot. */
const TICKET_HEADER = 'upload-ticket';
const TicketId = z.uuid();
const ALLOWED_EXT = /^[a-z0-9]{1,10}$/;

/**
 * tus sees the request through srvx, which reads `headers` or `rawHeaders` depending on access order, so both are
 * rewritten: any client-sent copy is dropped first.
 */
function setInternalHeader(raw: FastifyRequest['raw'], name: string, value: string) {
  const kept: string[] = [];
  for (let i = 0; i < raw.rawHeaders.length; i += 2) {
    if (raw.rawHeaders[i]!.toLowerCase() !== name) kept.push(raw.rawHeaders[i]!, raw.rawHeaders[i + 1]!);
  }
  kept.push(name, value);
  raw.rawHeaders.splice(0, raw.rawHeaders.length, ...kept);
  raw.headers[name] = value;
}

/** Every PATCH body together is written at the live upload rate (media/throttle.ts), whatever the client does. */
class PacedFileStore extends FileStore {
  override write(readable: Parameters<FileStore['write']>[0], id: string, offset: number) {
    return super.write(Readable.from(paced(readable, takeUpload), { highWaterMark: 1 }), id, offset);
  }
}

const tusError = (status: number, error: string, message: string) => ({ status_code: status, body: JSON.stringify({ error, message }) });

export function uploadRoutes(app: FastifyInstance, { db, cfg }: { db: Db; cfg: ServerConfig }) {
  const tus = new Server({
    path: '/api/uploads',
    datastore: new PacedFileStore({ directory: tusDir(cfg.MEDIA_ROOT) }),
    maxSize: cfg.UPLOAD_MAX_BYTES,
    relativeLocation: true,
    async onUploadCreate(req, upload) {
      const uploaderId = req.headers.get(USER_HEADER);
      const meta = UploadMetadata.safeParse(upload.metadata ?? {});
      if (!uploaderId || !meta.success) throw tusError(400, 'bad_request', 'Upload metadata is missing or invalid.');
      if (upload.size === undefined) throw tusError(400, 'bad_request', 'The upload length must be known.');
      const [ev] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, meta.data.eventId), isNull(events.deletedAt)));
      if (!ev) throw tusError(404, 'not_found', 'Not found.');
      const [ticket] = meta.data.ticketId
        ? await db
            .update(uploadTickets)
            .set({ uploadId: upload.id, lastSeenAt: new Date() })
            .where(and(eq(uploadTickets.id, meta.data.ticketId), eq(uploadTickets.uploaderId, uploaderId), eq(uploadTickets.status, 'granted')))
            .returning({ id: uploadTickets.id })
        : [];
      if (!ticket) throw tusError(409, 'no_slot', 'Wait for a free upload slot.');
      const ext = path.extname(meta.data.filename).slice(1).toLowerCase();
      await db.insert(assets).values({
        id: newId(),
        eventId: ev.id,
        kind: meta.data.filetype?.startsWith('video/') ? 'video' : 'image',
        tier: meta.data.tier,
        girlsOnly: meta.data.girlsOnly,
        status: 'uploading',
        originalFilename: meta.data.filename,
        originalMime: meta.data.filetype ?? null,
        originalExt: ALLOWED_EXT.test(ext) ? ext : 'bin',
        originalSize: upload.size,
        uploaderId,
        uploadId: upload.id,
      });
      return {};
    },
    async onUploadFinish(_req, upload) {
      try {
        const a = await ingest(db, { mediaRoot: cfg.MEDIA_ROOT, ffprobe: cfg.FFPROBE }, upload.id, upload.storage?.path ?? path.join(tusDir(cfg.MEDIA_ROOT), upload.id));
        wakeWorker(cfg.WORKER_WAKE);
        return { headers: { 'Asset-Id': a.id } };
      } catch (e) {
        if (e instanceof UnsupportedType) throw tusError(415, 'unsupported_type', "That file type isn't supported.");
        app.log.error({ err: e, uploadId: upload.id }, 'ingest failed');
        throw tusError(500, 'internal', 'Something went wrong on our side.');
      } finally {
        // The bytes are in either way, so the slot goes to the next file in line.
        await releaseUpload(db, upload.id, 'done').catch((err) => app.log.error({ err }, 'ticket release failed'));
      }
    },
  });
  // A cancelled upload (tus termination) takes its "uploading" row and its queue slot with it.
  tus.on(EVENTS.POST_TERMINATE, (_req, _res, id: string) => {
    void db.delete(assets).where(and(eq(assets.uploadId, id), eq(assets.status, 'uploading'))).catch((err) => app.log.error({ err }, 'terminate cleanup failed'));
    void releaseUpload(db, id, 'cancelled').catch((err) => app.log.error({ err }, 'ticket release failed'));
  });

  void app.register(async (scope) => {
    // tus reads the raw request stream itself.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, _payload, done) => done(null));

    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const v = viewerOf(req);
      setInternalHeader(req.raw, USER_HEADER, v.id);
      const id = (req.params as { '*': string })['*'];
      // An upload belongs to whoever created it; anyone else gets the same 404 as an unknown id.
      if (id) {
        const [own] = await db.select({ uploaderId: assets.uploaderId }).from(assets).where(eq(assets.uploadId, id));
        if (!own || own.uploaderId !== v.id) throw notFound();
        if (req.method === 'PATCH') {
          // A chunk needs a granted ticket; it links the ticket to this upload (a resume after a pause has a new one) and keeps it alive.
          const t = TicketId.safeParse(req.headers[TICKET_HEADER]);
          const [ok] = t.success
            ? await db
                .update(uploadTickets)
                .set({ uploadId: id, lastSeenAt: new Date() })
                .where(and(eq(uploadTickets.id, t.data), eq(uploadTickets.uploaderId, v.id), eq(uploadTickets.status, 'granted')))
                .returning({ id: uploadTickets.id })
            : [];
          if (!ok) throw new HttpError('no_slot');
          // Each chunk marks the row as alive; one untouched for an hour no longer counts as active.
          await db.update(assets).set({ updatedAt: new Date() }).where(and(eq(assets.uploadId, id), eq(assets.status, 'uploading')));
        }
      }
      // A finished upload's tus files are gone; answer a resuming client's HEAD from the asset row instead.
      if (req.method === 'HEAD' && id) {
        const [done] = await db
          .select({ size: assets.originalSize })
          .from(assets)
          .where(and(eq(assets.uploadId, id), eq(assets.uploaderId, v.id), sql`${assets.status} <> 'uploading'`));
        if (done) {
          return reply
            .code(200)
            .headers({ 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(done.size ?? 0), 'Upload-Length': String(done.size ?? 0), 'Cache-Control': 'no-store' })
            .send();
        }
      }
      reply.hijack();
      await tus.handle(req.raw, reply.raw);
    };
    scope.all('/api/uploads', { preHandler: requireCore }, handler);
    scope.all('/api/uploads/*', { preHandler: requireCore }, handler);
  });

  const BUCKET_STATUSES = {
    all: null,
    active: ['uploading', 'queued', 'processing'],
    attention: ['failed', 'needs_review'],
    ready: ['ready', 'original_only'],
  } as const;
  const MineCursor = z.object({ c: z.string(), i: z.string() });
  // An upload whose browser went away (tab closed, offline) stays 'uploading' until cleanup; after an hour it isn't active.
  const abandoned = sql`(${assets.status} = 'uploading' and ${assets.updatedAt} < now() - interval '1 hour')`;

  // One query: the caller's unfinished uploads with their running job's step and progress. The full list (with ETAs)
  // is only re-fetched when one of these changes status.
  app.get('/api/uploads/progress', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    const rows = await db
      .select({ assetId: assets.id, status: assets.status, step: jobs.step, progress: jobs.progress })
      .from(assets)
      .leftJoin(jobs, and(eq(jobs.assetId, assets.id), eq(jobs.state, 'running')))
      .where(and(eq(assets.uploaderId, v.id), isNull(assets.deletedAt), inArray(assets.status, ['uploading', 'queued', 'processing']), sql`not ${abandoned}`))
      .limit(200);
    return { items: rows };
  });

  app.get('/api/uploads/mine', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    const qry = MyUploadsQuery.parse(req.query);
    const cur = decodeCursor(MineCursor, qry.cursor);
    const inBucket = BUCKET_STATUSES[qry.bucket];
    const rows = await db
      .select({ a: assets, eventTitle: events.title, eventStartsOn: events.startsOn, c: sql<string>`to_char(${assets.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(assets)
      .innerJoin(events, eq(events.id, assets.eventId))
      .where(
        and(
          eq(assets.uploaderId, v.id),
          isNull(assets.deletedAt),
          isNull(events.deletedAt),
          sql`${assets.status} <> 'deleting'`,
          inBucket ? inArray(assets.status, [...inBucket]) : undefined,
          qry.bucket === 'active' ? sql`not ${abandoned}` : undefined,
          cur ? sql`(${assets.createdAt}, ${assets.id}) < (${cur.c}::timestamptz, ${cur.i}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(assets.createdAt), desc(assets.id))
      .limit(qry.limit + 1);
    const page = rows.slice(0, qry.limit);
    const ids = page.map((r) => r.a.id);
    const [queue, failures, countRows] = await Promise.all([
      activeJobs(db),
      ids.length
        ? db
            .select({ assetId: jobs.assetId, error: jobs.lastError })
            .from(jobs)
            .where(and(inArray(jobs.assetId, ids), eq(jobs.state, 'failed')))
            .orderBy(desc(jobs.finishedAt))
        : Promise.resolve([]),
      db
        .select({ status: assets.status, abandoned: sql<boolean>`${abandoned}`, n: sql<number>`count(*)::int` })
        .from(assets)
        .innerJoin(events, eq(events.id, assets.eventId))
        .where(and(eq(assets.uploaderId, v.id), isNull(assets.deletedAt), isNull(events.deletedAt), sql`${assets.status} <> 'deleting'`))
        .groupBy(assets.status, abandoned),
    ]);
    const active = byAsset(queue);
    const queuedOrder = queue.filter((j) => j.state === 'queued');
    const count = (sts: readonly string[] | null, live = false) => countRows.filter((r) => (!sts || sts.includes(r.status)) && !(live && r.abandoned)).reduce((s, r) => s + r.n, 0);
    const errorOf = new Map<string, string | null>();
    for (const f of failures) if (f.assetId && !errorOf.has(f.assetId)) errorOf.set(f.assetId, f.error);
    const last = page.at(-1);
    return {
      items: page.map(({ a, eventTitle, eventStartsOn }): MyUploadItem => {
        const j = active.get(a.id);
        return {
          assetId: a.id,
          uploadId: a.status === 'uploading' ? a.uploadId : null,
          eventId: a.eventId,
          eventTitle,
          eventStartsOn,
          filename: a.originalFilename,
          kind: a.kind,
          tier: a.tier,
          girlsOnly: a.girlsOnly,
          status: a.status,
          bytes: a.originalSize,
          durationS: a.durationS,
          hdr: a.hdr,
          queuePosition: j?.state === 'queued' ? queuedOrder.indexOf(j) + 1 : null,
          step: j?.step ?? null,
          progress: j?.progress ?? null,
          readyInS: j?.readyInS ?? null,
          error: a.status === 'failed' ? (errorOf.get(a.id) ?? null) : a.status === 'needs_review' ? a.reviewReason : null,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        };
      }),
      nextCursor: rows.length > qry.limit && last ? encodeCursor({ c: last.c, i: last.a.id }) : null,
      counts: { all: count(null), active: count(BUCKET_STATUSES.active, true), attention: count(BUCKET_STATUSES.attention), ready: count(BUCKET_STATUSES.ready) },
    };
  });

  /** Names and sizes already in an event, so the upload screen can flag likely duplicates before sending. */
  app.get('/api/uploads/existing', { preHandler: requireCore }, async (req) => {
    const { eventId } = z.object({ eventId: z.uuid() }).parse(req.query);
    const rows = await db
      .select({ filename: assets.originalFilename, bytes: assets.originalSize })
      .from(assets)
      .where(and(eq(assets.eventId, eventId), isNull(assets.deletedAt), girlsOk(viewerOf(req)), sql`${assets.status} not in ('deleting', 'uploading')`));
    return { items: rows };
  });

  const limitTickets = makeLimiter(app, 'uploadTickets', (req) => viewerOf(req).id);

  /** A place in the server-wide upload queue for one file; the tus create must carry it once granted. */
  app.post('/api/uploads/tickets', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    await limitTickets(req);
    const body = UploadTicketBody.parse(req.body);
    if (body.bytes > cfg.UPLOAD_MAX_BYTES) throw new HttpError('too_large');
    const [ev] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, body.eventId), isNull(events.deletedAt)));
    if (!ev) throw notFound();
    const id = newId();
    await db.insert(uploadTickets).values({ id, uploaderId: v.id, eventId: ev.id, kind: body.kind, bytes: body.bytes, filename: body.filename, girlsOnly: body.girlsOnly });
    await grantTickets(db);
    const t = await ticketState(db, id);
    if (!t) throw new HttpError('internal');
    return t;
  });

  /** Gives up a place in the queue (a file cancelled or paused before it finished). */
  app.delete('/api/uploads/tickets/:id', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [t] = await db
      .update(uploadTickets)
      .set({ status: 'cancelled' })
      .where(and(eq(uploadTickets.id, id), eq(uploadTickets.uploaderId, v.id), inArray(uploadTickets.status, ['waiting', 'granted'])))
      .returning({ id: uploadTickets.id });
    if (!t) throw notFound();
    await grantTickets(db);
    return { ok: true };
  });

  /**
   * The public upload queue for every core member: who is uploading or waiting, with kind, size and progress only.
   * Filenames and ticket ids go to their own uploader alone; events, assets and girls-only flags never appear.
   */
  app.get('/api/uploads/queue', { preHandler: requireCore }, async (req): Promise<UploadQueue> => {
    const v = viewerOf(req);
    // Polling is what keeps this person's not-yet-started tickets alive; started ones live on their chunks.
    await db
      .update(uploadTickets)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(uploadTickets.uploaderId, v.id), inArray(uploadTickets.status, ['waiting', 'granted']), isNull(uploadTickets.uploadId)));
    await grantTickets(db);
    const rows = await db
      .select({ t: uploadTickets, name: users.name })
      .from(uploadTickets)
      .innerJoin(users, eq(users.id, uploadTickets.uploaderId))
      .where(inArray(uploadTickets.status, ['granted', 'waiting']))
      .orderBy(sql`${uploadTickets.status} <> 'granted'`, asc(uploadTickets.createdAt), asc(uploadTickets.id));
    // The tus file's size is the offset received so far: one stat per uploading file (at most MAX_UPLOAD_SLOTS).
    const received = await Promise.all(
      rows.map(({ t }) =>
        t.status !== 'granted' ? null : t.uploadId && /^[\w-]+$/.test(t.uploadId) ? stat(path.join(tusDir(cfg.MEDIA_ROOT), t.uploadId)).then((s) => s.size, () => null) : 0,
      ),
    );
    const at = { granted: 0, waiting: 0 };
    return {
      slots: MAX_UPLOAD_SLOTS,
      inUse: rows.filter((r) => r.t.status === 'granted').length,
      rateBps: Math.round(ioRates().upload),
      items: rows.map(({ t, name }, i) => ({
        position: ++at[t.status as 'granted' | 'waiting'],
        state: t.status === 'granted' ? 'uploading' : 'waiting',
        uploader: name,
        kind: t.kind === 'video' ? 'video' : 'photo',
        bytes: t.bytes,
        progress: received[i] ?? null,
        createdAt: t.createdAt.toISOString(),
        ...(t.uploaderId === v.id ? { ticketId: t.id, filename: t.filename } : {}),
      })),
    };
  });

  app.post('/api/uploads/:assetId/retry', { preHandler: requireCore }, async (req) => {
    const v = viewerOf(req);
    const { assetId } = z.object({ assetId: z.uuid() }).parse(req.params);
    const [a] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), isNull(assets.deletedAt), v.isAdmin ? undefined : eq(assets.uploaderId, v.id)));
    if (!a) throw notFound();
    if (a.status !== 'failed') throw new HttpError('conflict');
    await db.transaction(async (tx) => {
      await tx.update(assets).set({ status: 'queued', updatedAt: new Date() }).where(eq(assets.id, a.id));
      await tx.insert(jobs).values({ id: newId(), assetId: a.id, kind: 'process', priority: a.kind === 'image' ? 100 : 0 });
      if (v.isAdmin && a.uploaderId !== v.id) await audit(tx, v.id, 'asset.retry', { type: 'asset', id: a.id });
    });
    return { ok: true };
  });

  return tus;
}
