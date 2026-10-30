// Admin API: members, processing queue, item processing details, storage and settings. Every mutation writes
// audit_log. All routes 404 for non-admins (requireAdmin).
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '@acm/core/config';
import { parseMasterKey, unwrapKey } from '@acm/core/crypto';
import { accessRequests, appSettings, assetKeys, assets, type Db, events, jobs, processingRuns, renditions, sessions, users } from '@acm/core/db';
import { newId } from '@acm/core/ids';
import { revDir, tonemapGatePath } from '@acm/core/paths';
import {
  AdminJobQuery,
  AdminUserQuery,
  BulkUsersBody,
  CreateUserBody,
  Email,
  Id,
  PageQuery,
  PatchSettingsBody,
  PatchUserBody,
  ReprocessBody,
  ResolveBody,
  type Viewer,
} from '@acm/core/schemas';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSuperadmin, requireAdmin, viewerOf } from '../auth/plugin.ts';
import { audit } from '../lib/audit.ts';
import { decodeCursor, encodeCursor } from '../lib/cursor.ts';
import { thumbUrl } from '../lib/dto.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { computeUsage } from '../lib/compute.ts';
import { poolSnapshot } from '../media/throttle.ts';
import { activeJobs, drainOf, loadRho } from '../lib/queue.ts';
import type { Mailer } from '../mail/mailer.ts';
import { seesGirlsOnly } from '../policy/canView.ts';
import { sendFile, sendSealed } from './media.ts';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const OffsetCursor = z.object({ o: z.number().int().min(0) });
const UserCursor = z.object({ c: z.string(), i: z.string() });

async function setting<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return (row?.value as T) ?? null;
}
const onlySuperadmin = () => new HttpError('not_allowed', {}, 'Only the super admin can make or remove admins.');

const putSetting = (db: Pick<Db, 'insert'>, key: string, value: unknown) =>
  db.insert(appSettings).values({ key, value }).onConflictDoUpdate({ target: appSettings.key, set: { value } });

export function adminRoutes(app: FastifyInstance, { db, cfg, mailer }: { db: Db; cfg: ServerConfig; mailer: Mailer }) {
  const gatePassed = () => existsSync(tonemapGatePath(cfg.LUTS_DIR));
  const master = parseMasterKey(cfg.MASTER_KEY);

  // ── Members ────────────────────────────────────────────────────────────────────────────────────────
  app.get('/api/admin/users', { preHandler: requireAdmin }, async (req) => {
    const q = AdminUserQuery.parse(req.query);
    const cur = decodeCursor(UserCursor, q.cursor);
    const rows = await db
      .select({ u: users, c: sql<string>`to_char(${users.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(users)
      .where(
        and(
          q.q ? or(ilike(users.email, `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`), ilike(users.name, `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)) : undefined,
          q.status ? eq(users.status, q.status) : undefined,
          cur ? sql`(${users.createdAt}, ${users.id}) < (${cur.c}::timestamptz, ${cur.i}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    const [counts] = await db
      .select({
        all: sql<number>`count(*)::int`,
        core: sql<number>`count(*) filter (where ${users.role} = 'core')::int`,
        admins: sql<number>`count(*) filter (where ${users.isAdmin})::int`,
        disabled: sql<number>`count(*) filter (where ${users.status} = 'disabled')::int`,
      })
      .from(users);
    return {
      items: page.map(({ u }) => ({ id: u.id, email: u.email, name: u.name, role: u.role, isAdmin: u.isAdmin, isSuperadmin: isSuperadmin(cfg, u), status: u.status, isFemale: u.isFemale, createdAt: u.createdAt.toISOString(), lastLoginAt: iso(u.lastLoginAt) })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ c: last.c, i: last.u.id }) : null,
      counts,
    };
  });

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (req, reply) => {
    const v = viewerOf(req);
    const body = CreateUserBody.parse(req.body);
    if (body.isAdmin && !v.isSuperadmin) throw onlySuperadmin();
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email));
    if (exists) throw new HttpError('conflict', { fields: { email: 'exists' } }, 'Someone with that email is already a member.');
    const id = newId();
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id, ...body, role: 'core', createdBy: v.id });
      await audit(tx, v.id, 'user.create', { type: 'user', id }, { email: body.email, isAdmin: body.isAdmin });
    });
    return reply.code(201).send({ id });
  });

  // ── Access requests (from "Request access" on the sign-in screen) ───────────────────────────────────
  app.get('/api/admin/access-requests', { preHandler: requireAdmin }, async (req) => {
    const q = PageQuery.parse(req.query);
    const offset = decodeCursor(OffsetCursor, q.cursor)?.o ?? 0;
    const rows = await db
      .select()
      .from(accessRequests)
      .orderBy(sql`(${accessRequests.status} = 'pending') desc`, desc(accessRequests.createdAt), desc(accessRequests.id))
      .limit(q.limit + 1)
      .offset(offset);
    const [{ pending } = { pending: 0 }] = await db.select({ pending: sql<number>`count(*)::int` }).from(accessRequests).where(eq(accessRequests.status, 'pending'));
    return {
      items: rows.slice(0, q.limit).map((r) => ({ id: r.id, email: r.email, name: r.name, isFemale: r.isFemale, status: r.status, createdAt: r.createdAt.toISOString(), decidedAt: iso(r.decidedAt) })),
      nextCursor: rows.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null,
      pending,
    };
  });

  app.post('/api/admin/access-requests/:id/approve', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: Id }).parse(req.params);
    const result = await db.transaction(async (tx) => {
      const [r] = await tx.select().from(accessRequests).where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'pending'))).for('update');
      if (!r) return notFound();
      const [exists] = await tx.select({ id: users.id }).from(users).where(eq(users.email, r.email));
      if (exists) return new HttpError('conflict', { fields: { email: 'exists' } }, 'Someone with that email is already a member.');
      const userId = newId();
      await tx.insert(users).values({ id: userId, email: r.email, name: r.name, isFemale: r.isFemale, role: 'core', isAdmin: false, status: 'active', createdBy: v.id });
      await tx.update(accessRequests).set({ status: 'approved', decidedAt: new Date(), decidedBy: v.id }).where(eq(accessRequests.id, r.id));
      await audit(tx, v.id, 'access_request.approve', { type: 'user', id: userId }, { requestId: r.id });
      return { userId, email: r.email };
    });
    if (result instanceof HttpError) throw result;
    // After the response, like the sign-in code mail.
    setImmediate(() => mailer.sendApproved(result.email).catch((err) => req.log.error({ err }, 'approval mail failed')));
    return { ok: true, userId: result.userId };
  });

  app.post('/api/admin/access-requests/:id/reject', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: Id }).parse(req.params);
    const done = await db.transaction(async (tx) => {
      const [r] = await tx
        .update(accessRequests)
        .set({ status: 'rejected', decidedAt: new Date(), decidedBy: v.id })
        .where(and(eq(accessRequests.id, id), eq(accessRequests.status, 'pending')))
        .returning({ id: accessRequests.id });
      if (r) await audit(tx, v.id, 'access_request.reject', { type: 'access_request', id: r.id });
      return !!r;
    });
    if (!done) throw notFound();
    return { ok: true };
  });

  app.post('/api/admin/users/bulk', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const { emails, isAdmin } = BulkUsersBody.parse(req.body);
    if (isAdmin && !v.isSuperadmin) throw onlySuperadmin();
    const skipped: { email: string; reason: 'invalid' | 'exists' | 'duplicate' }[] = [];
    const valid: string[] = [];
    const seen = new Set<string>();
    for (const raw of emails.flatMap((e) => e.split(/[\s,;]+/)).filter(Boolean)) {
      const r = Email.safeParse(raw);
      if (!r.success) skipped.push({ email: raw, reason: 'invalid' });
      else if (seen.has(r.data)) skipped.push({ email: r.data, reason: 'duplicate' });
      else {
        seen.add(r.data);
        valid.push(r.data);
      }
    }
    const existing = valid.length ? new Set((await db.select({ email: users.email }).from(users).where(inArray(users.email, valid))).map((r) => r.email)) : new Set<string>();
    const fresh = valid.filter((e) => !existing.has(e));
    for (const e of valid) if (existing.has(e)) skipped.push({ email: e, reason: 'exists' });
    if (fresh.length) {
      await db.transaction(async (tx) => {
        await tx.insert(users).values(fresh.map((email) => ({ id: newId(), email, role: 'core' as const, isAdmin, createdBy: v.id })));
        await audit(tx, v.id, 'user.bulk_create', { type: 'user', id: v.id }, { count: fresh.length, isAdmin });
      });
    }
    return { created: fresh.length, skipped };
  });

  app.patch('/api/admin/users/:id', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: Id }).parse(req.params);
    const body = PatchUserBody.parse(req.body);
    const result = await db.transaction(async (tx) => {
      // Lock every admin row first, so two admins can't demote each other at the same moment.
      await tx.execute(sql`select id from ${users} where ${users.isAdmin} for update`);
      const [u] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (!u) return notFound();
      const targetSuper = isSuperadmin(cfg, u);
      if (targetSuper && !v.isSuperadmin) return new HttpError('not_allowed', {}, "Only the super admin can change a super admin's account.");
      if (body.isAdmin !== undefined && body.isAdmin !== u.isAdmin && !v.isSuperadmin) return onlySuperadmin();
      // Every account is core; an old member row becomes core when it's edited, so the admin flag is always valid.
      const role = 'core' as const;
      const isAdmin = body.isAdmin ?? u.isAdmin;
      const status = body.status ?? u.status;
      const wasActiveAdmin = u.isAdmin && u.status === 'active';
      const staysActiveAdmin = isAdmin && status === 'active';
      // Super admins come from SUPERADMINS in the server's .env, so only that file can remove one.
      if (targetSuper && !staysActiveAdmin) return new HttpError('not_allowed', {}, "A super admin can't be demoted or disabled here; they're set in the server configuration.");
      if (wasActiveAdmin && !staysActiveAdmin) {
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(users)
          .where(and(eq(users.isAdmin, true), eq(users.status, 'active'), sql`${users.id} <> ${u.id}`));
        if (n === 0) return new HttpError('not_allowed', {}, 'There has to be at least one admin.');
      }
      const next = { role, isAdmin, status, name: body.name ?? u.name };
      await tx.update(users).set(next).where(eq(users.id, u.id));
      if (status === 'disabled' && u.status !== 'disabled') await tx.delete(sessions).where(eq(sessions.userId, u.id));
      const changed = Object.fromEntries(Object.entries(next).filter(([k, val]) => (u as Record<string, unknown>)[k] !== val));
      await audit(tx, v.id, 'user.update', { type: 'user', id: u.id }, changed);
      return next;
    });
    if (result instanceof HttpError) throw result;
    return { ok: true, ...result };
  });

  // ── Processing queue ───────────────────────────────────────────────────────────────────────────────
  app.get('/api/admin/jobs', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const q = AdminJobQuery.parse(req.query);
    const offset = decodeCursor(OffsetCursor, q.cursor)?.o ?? 0;
    const queue = await activeJobs(db);
    const eta = new Map(queue.map((j) => [j.jobId, j.readyInS]));
    // Deleted items leave the queue at once: their purge job is internal, and older jobs lose their asset.
    const live = sql`(${jobs.kind} <> 'purge' and ${assets.deletedAt} is null and ${assets.status} <> 'deleting')`;
    const base = db
      .select({ j: jobs, a: assets, eventTitle: events.title })
      .from(jobs)
      .innerJoin(assets, eq(assets.id, jobs.assetId))
      .leftJoin(events, eq(events.id, assets.eventId));
    let rows;
    if (q.tab === 'running') rows = await base.where(and(live, eq(jobs.state, 'running'))).orderBy(asc(jobs.startedAt)).limit(q.limit + 1).offset(offset);
    else if (q.tab === 'queued') rows = await base.where(and(live, eq(jobs.state, 'queued'))).orderBy(desc(jobs.priority), asc(jobs.createdAt)).limit(q.limit + 1).offset(offset);
    else if (q.tab === 'failed') rows = await base.where(and(live, eq(jobs.state, 'failed'), sql`${assets.status} = 'failed'`)).orderBy(desc(jobs.finishedAt)).limit(q.limit + 1).offset(offset);
    else if (q.tab === 'needs_review') {
      // Listed from the asset status (the source of truth), each with its most recent job if there is one.
      const flagged = await db
        .select({ a: assets, eventTitle: events.title })
        .from(assets)
        .innerJoin(events, eq(events.id, assets.eventId))
        .where(and(eq(assets.status, 'needs_review'), isNull(assets.deletedAt)))
        .orderBy(desc(assets.updatedAt))
        .limit(q.limit + 1)
        .offset(offset);
      const latest = flagged.length
        ? await db.select().from(jobs).where(inArray(jobs.assetId, flagged.map((f) => f.a.id))).orderBy(desc(jobs.createdAt))
        : [];
      rows = flagged.map(({ a, eventTitle }) => {
        const j = latest.find((x) => x.assetId === a.id);
        return { a, eventTitle, j: j ?? { id: a.id, assetId: a.id, kind: 'process' as const, state: 'done' as const, outcome: 'needs_review' as const, params: {}, priority: 0, attempts: 0, maxAttempts: 3, runAfter: a.updatedAt, step: null, progress: null, estSeconds: null, startedAt: null, finishedAt: a.updatedAt, lastError: null, createdAt: a.createdAt } };
      });
    }
    else rows = await base.where(and(live, eq(jobs.state, 'done'), gte(jobs.finishedAt, new Date(Date.now() - 7 * 86400_000)))).orderBy(desc(jobs.finishedAt)).limit(q.limit + 1).offset(offset);

    const [counts] = await db
      .select({
        running: sql<number>`count(*) filter (where ${jobs.state} = 'running')::int`,
        queued: sql<number>`count(*) filter (where ${jobs.state} = 'queued')::int`,
      })
      .from(jobs)
      .innerJoin(assets, eq(assets.id, jobs.assetId))
      .where(live);
    const [{ failed } = { failed: 0 }] = await db.select({ failed: sql<number>`count(distinct ${jobs.assetId})::int` }).from(jobs).innerJoin(assets, eq(assets.id, jobs.assetId)).where(and(live, eq(jobs.state, 'failed'), eq(assets.status, 'failed')));
    const [{ review } = { review: 0 }] = await db.select({ review: sql<number>`count(*)::int` }).from(assets).where(and(eq(assets.status, 'needs_review'), isNull(assets.deletedAt)));
    const [{ videoS } = { videoS: 0 }] = await db
      .select({ videoS: sql<number>`coalesce(sum(${assets.durationS}), 0)::float` })
      .from(jobs)
      .innerJoin(assets, eq(assets.id, jobs.assetId))
      .where(and(live, eq(jobs.state, 'queued'), eq(assets.kind, 'video')));
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(({ j, a, eventTitle }) => ({
        id: j.id,
        kind: j.kind,
        state: j.state,
        priority: j.priority,
        attempts: j.attempts,
        maxAttempts: j.maxAttempts,
        step: j.step,
        progress: j.progress,
        readyInS: eta.get(j.id) ?? null,
        lastError: j.lastError,
        createdAt: j.createdAt.toISOString(),
        startedAt: iso(j.startedAt),
        finishedAt: iso(j.finishedAt),
        // A girls-only item the admin may not see keeps its queue row (counts, cancel, retry) but not its details.
        asset: a && (!a.girlsOnly || seesGirlsOnly(v)) ? { id: a.id, filename: a.originalFilename, status: a.status, eventTitle: eventTitle ?? '', thumbUrl: thumbUrl(a), kind: a.kind, durationS: a.durationS, hdr: a.hdr, bytes: a.originalSize, reviewReason: a.reviewReason } : null,
      })),
      nextCursor: rows.length > q.limit ? encodeCursor({ o: offset + q.limit }) : null,
      summary: {
        running: counts?.running ?? 0,
        queued: counts?.queued ?? 0,
        failed,
        needsReview: review,
        queuedVideoS: videoS,
        drainS: drainOf(queue),
        workerTick: await setting<string>(db, 'worker_tick'),
      },
    };
  });

  const jobParam = (p: unknown) => z.object({ id: Id }).parse(p).id;

  app.post('/api/admin/jobs/:id/retry', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const id = jobParam(req.params);
    await db.transaction(async (tx) => {
      const [j] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!j) throw notFound();
      if (j.state !== 'failed' && j.state !== 'cancelled') throw new HttpError('conflict');
      await tx.insert(jobs).values({ id: newId(), assetId: j.assetId, kind: j.kind, params: j.params, priority: j.priority });
      if (j.assetId) await tx.update(assets).set({ status: 'queued', updatedAt: new Date() }).where(and(eq(assets.id, j.assetId), eq(assets.status, 'failed')));
      await audit(tx, v.id, 'job.retry', { type: 'job', id: j.id });
    });
    return { ok: true };
  });

  app.post('/api/admin/jobs/:id/cancel', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const id = jobParam(req.params);
    await db.transaction(async (tx) => {
      const [j] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!j) throw notFound();
      if (j.state !== 'queued' && j.state !== 'running') throw new HttpError('conflict');
      // A running job notices within seconds (the worker polls its state) and stops.
      await tx.update(jobs).set({ state: 'cancelled', ...(j.state === 'queued' ? { finishedAt: new Date() } : {}) }).where(eq(jobs.id, j.id));
      if (j.state === 'queued' && j.assetId && j.kind === 'process') await tx.update(assets).set({ status: 'failed', updatedAt: new Date() }).where(and(eq(assets.id, j.assetId), eq(assets.status, 'queued')));
      await audit(tx, v.id, 'job.cancel', { type: 'job', id: j.id });
    });
    return { ok: true };
  });

  app.post('/api/admin/jobs/:id/prioritize', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const id = jobParam(req.params);
    await db.transaction(async (tx) => {
      const [j] = await tx.select().from(jobs).where(eq(jobs.id, id)).for('update');
      if (!j) throw notFound();
      if (j.state !== 'queued') throw new HttpError('conflict');
      await tx.execute(sql`update ${jobs} set priority = (select coalesce(max(priority), 0) + 1 from ${jobs} where state = 'queued') where id = ${j.id}`);
      await audit(tx, v.id, 'job.prioritize', { type: 'job', id: j.id });
    });
    return { ok: true };
  });

  // ── Item details ───────────────────────────────────────────────────────────────────────────────────
  async function adminAsset(v: Viewer, id: string) {
    if (!Id.safeParse(id).success) throw notFound();
    const [row] = await db.select({ a: assets, eventTitle: events.title }).from(assets).innerJoin(events, eq(events.id, assets.eventId)).where(and(eq(assets.id, id), isNull(assets.deletedAt)));
    if (!row || row.a.status === 'deleting' || (row.a.girlsOnly && !seesGirlsOnly(v))) throw notFound();
    return row;
  }

  app.get('/api/admin/assets/:id/processing', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { a, eventTitle } = await adminAsset(viewerOf(req), id);
    const [rs, runs, js, queue] = await Promise.all([
      db.select().from(renditions).where(eq(renditions.assetId, a.id)),
      db.select().from(processingRuns).where(eq(processingRuns.assetId, a.id)).orderBy(desc(processingRuns.startedAt)).limit(10),
      db.select().from(jobs).where(eq(jobs.assetId, a.id)).orderBy(desc(jobs.createdAt)).limit(20),
      activeJobs(db),
    ]);
    const { jobCost } = await import('@acm/core/eta');
    const own = jobCost({ kind: a.kind, hdr: a.hdr, durationS: a.durationS, progress: null }, await loadRho(db));
    return {
      asset: {
        id: a.id,
        filename: a.originalFilename,
        kind: a.kind,
        tier: a.tier,
        girlsOnly: a.girlsOnly,
        status: a.status,
        eventId: a.eventId,
        eventTitle,
        reviewReason: a.reviewReason,
        hdr: a.hdr,
        durationS: a.durationS,
        width: a.width,
        height: a.height,
        originalSize: a.originalSize,
        encrypted: a.encrypted,
        duplicateOf: a.duplicateOf,
        sourceInfo: a.sourceInfo,
        thumbUrl: thumbUrl(a),
      },
      renditions: rs.map((r) => ({ kind: r.kind, label: r.label, width: r.width, height: r.height, bandwidth: r.bandwidth, bytes: r.bytes, encrypted: r.encrypted })),
      runs: runs.map((r) => ({ id: r.id, startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), ok: r.ok, toneCurve: r.toneCurve, curveSource: r.curveSource, scores: r.scores, error: r.error })),
      jobs: js.map((j) => ({ id: j.id, kind: j.kind, state: j.state, attempts: j.attempts, lastError: j.lastError, createdAt: j.createdAt.toISOString(), finishedAt: iso(j.finishedAt) })),
      reprocessEtaS: Math.round(drainOf(queue) + own),
    };
  });

  // The frames automatic tone-curve selection scored, as the chosen curve renders them (r<rev>/frames/<n>.webp).
  app.get('/api/admin/assets/:id/frames/:n', { preHandler: requireAdmin }, async (req, reply) => {
    const p = z.object({ id: z.string(), n: z.coerce.number().int().min(0).max(15) }).safeParse(req.params);
    if (!p.success) throw notFound();
    const { a } = await adminAsset(viewerOf(req), p.data.id);
    if (a.kind !== 'video' || a.renditionRev < 1) throw notFound();
    const file = path.join(revDir(cfg.MEDIA_ROOT, a.id, a.renditionRev), 'frames', `${p.data.n}.webp`);
    // The URL carries ?r=<run id>, so a re-process gets a new URL and the long cache is safe.
    const headers = { 'Cache-Control': 'private, max-age=86400' };
    if (existsSync(file)) return sendFile(req, reply, file, 'image/webp', headers);
    if (!existsSync(`${file}.enc`)) throw notFound();
    const [k] = await db.select().from(assetKeys).where(eq(assetKeys.assetId, a.id));
    if (!k) throw notFound();
    return sendSealed(req, reply, `${file}.enc`, unwrapKey(k.fileKeyWrapped, master), a.id, 'image/webp', headers);
  });

  app.post('/api/admin/assets/:id/reprocess', { preHandler: requireAdmin }, async (req, reply) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = ReprocessBody.parse(req.body ?? {});
    const { a } = await adminAsset(v, id);
    if (a.status === 'uploading') throw new HttpError('conflict');
    const jobId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(jobs).values({ id: jobId, assetId: a.id, kind: 'reprocess', priority: 50, params: body.toneCurve ? { toneCurve: body.toneCurve, curveSource: 'override' } : {} });
      if (a.status === 'failed') await tx.update(assets).set({ status: 'queued', updatedAt: new Date() }).where(eq(assets.id, a.id));
      await audit(tx, v.id, 'asset.reprocess', { type: 'asset', id: a.id }, body);
    });
    return reply.code(202).send({ jobId });
  });

  app.post('/api/admin/assets/:id/resolve', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { action } = ResolveBody.parse(req.body);
    const { a } = await adminAsset(v, id);
    if (a.status !== 'needs_review') throw new HttpError('conflict');
    await db.transaction(async (tx) => {
      if (action === 'process_default') {
        await tx.update(assets).set({ status: 'queued', updatedAt: new Date() }).where(eq(assets.id, a.id));
        await tx.insert(jobs).values({ id: newId(), assetId: a.id, kind: 'process', priority: a.kind === 'image' ? 100 : 0, params: { force: true } });
      } else {
        await tx.update(assets).set({ status: 'original_only', updatedAt: new Date() }).where(eq(assets.id, a.id));
        // Seals the original if the item is core tier.
        await tx.insert(jobs).values({ id: newId(), assetId: a.id, kind: 'retier', priority: 100 });
      }
      await audit(tx, v.id, 'asset.resolve', { type: 'asset', id: a.id }, { action, reason: a.reviewReason });
    });
    return { ok: true };
  });

  // ── Storage and settings ───────────────────────────────────────────────────────────────────────────
  app.get('/api/admin/compute', { preHandler: requireAdmin }, async () => ({ ...(await computeUsage()), pool: poolSnapshot() }));

  app.get('/api/admin/storage', { preHandler: requireAdmin }, async () => {
    type Stats = { at: string; bytesOriginals: number; bytesRenditions: number; files: number; byKind?: { originals: number; photoCopies: number; videoFiles: number; other: number } };
    const stats = await setting<Stats>(db, 'storage_stats');
    const history = (await setting<{ date: string; bytes: number; files: number }[]>(db, 'storage_history')) ?? [];
    const top = await db.execute<{ id: string; title: string; slug: string; bytes: number; items: number }>(sql`
      select e.id, e.title, e.slug, (coalesce(sum(a.original_size), 0) + coalesce(sum(r.bytes), 0))::float as bytes, count(distinct a.id)::int as items
      from ${events} e join ${assets} a on a.event_id = e.id and a.deleted_at is null
      left join (select asset_id, sum(bytes) as bytes from ${renditions} group by asset_id) r on r.asset_id = a.id
      where e.deleted_at is null group by e.id order by bytes desc limit 5`);
    const disk = await statfs(cfg.MEDIA_ROOT).catch(() => null);
    return {
      measuredAt: stats?.at ?? null,
      bytesOriginals: stats?.bytesOriginals ?? 0,
      bytesRenditions: stats?.bytesRenditions ?? 0,
      files: stats?.files ?? 0,
      byKind: stats?.byKind ?? null,
      inodeLimit: await setting<number>(db, 'inode_limit'),
      diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
      topEvents: top.rows,
      history: history.slice(-90),
    };
  });

  app.get('/api/admin/settings', { preHandler: requireAdmin }, async () => ({
    tonemapAuto: (await setting<boolean>(db, 'tonemap_auto')) ?? false,
    tonemapGatePassed: gatePassed(),
    inodeLimit: await setting<number>(db, 'inode_limit'),
  }));

  app.patch('/api/admin/settings', { preHandler: requireAdmin }, async (req) => {
    const v = viewerOf(req);
    const body = PatchSettingsBody.parse(req.body);
    await db.transaction(async (tx) => {
      if (body.tonemapAuto !== undefined) await putSetting(tx, 'tonemap_auto', body.tonemapAuto);
      if (body.inodeLimit !== undefined) await putSetting(tx, 'inode_limit', body.inodeLimit);
      await audit(tx, v.id, 'settings.update', { type: 'settings', id: v.id }, body);
    });
    return { ok: true };
  });
}
