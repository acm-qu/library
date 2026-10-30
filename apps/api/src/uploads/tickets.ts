// The server-wide upload queue: at most MAX_UPLOAD_SLOTS files upload at once across all users (they share the
// live upload rate); every other file waits for a slot, first come first served. Grants happen lazily, on every
// queue read and every ticket create, finish or cancel.
import { type Db, expireUploadTickets, uploadTickets } from '@acm/core/db';
import type { UploadTicket } from '@acm/core/schemas';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

export const MAX_UPLOAD_SLOTS = 4;
/** A browser uploads 2 files at a time, so a 3rd slot for one person would sit idle while others wait. */
export const SLOTS_PER_USER = 2;
// Row locks on the waiting rows can't stop two passes from each granting a different row, so passes take turns.
const GRANT_LOCK = 7_310_001;

/** Expires stale tickets, then grants the oldest waiting ones (at most SLOTS_PER_USER each) while slots are free. */
export async function grantTickets(db: Db) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${GRANT_LOCK})`);
    await expireUploadTickets(tx);
    const [g] = await tx.select({ n: count() }).from(uploadTickets).where(eq(uploadTickets.status, 'granted'));
    const free = MAX_UPLOAD_SLOTS - (g?.n ?? 0);
    if (free <= 0) return;
    const held = new Map(
      (await tx.select({ user: uploadTickets.uploaderId, n: count() }).from(uploadTickets).where(eq(uploadTickets.status, 'granted')).groupBy(uploadTickets.uploaderId)).map((r) => [r.user, r.n]),
    );
    const waiting = await tx.select({ id: uploadTickets.id, user: uploadTickets.uploaderId }).from(uploadTickets).where(eq(uploadTickets.status, 'waiting')).orderBy(asc(uploadTickets.createdAt), asc(uploadTickets.id));
    const next: string[] = [];
    for (const w of waiting) {
      if (next.length >= free) break;
      if ((held.get(w.user) ?? 0) >= SLOTS_PER_USER) continue;
      held.set(w.user, (held.get(w.user) ?? 0) + 1);
      next.push(w.id);
    }
    if (!next.length) return;
    const now = new Date();
    await tx.update(uploadTickets).set({ status: 'granted', grantedAt: now, lastSeenAt: now }).where(inArray(uploadTickets.id, next));
  });
}

/** Ends the granted ticket of a tus upload (finished or cancelled) and hands its slot on. */
export async function releaseUpload(db: Db, uploadId: string, status: 'done' | 'cancelled') {
  await db.update(uploadTickets).set({ status }).where(and(eq(uploadTickets.uploadId, uploadId), eq(uploadTickets.status, 'granted')));
  await grantTickets(db);
}

/** A ticket's state and 1-based place within it, as the creating browser sees it. */
export async function ticketState(db: Db, id: string): Promise<z.infer<typeof UploadTicket> | null> {
  const [t] = await db.select().from(uploadTickets).where(eq(uploadTickets.id, id));
  if (!t || (t.status !== 'granted' && t.status !== 'waiting')) return null;
  const [p] = await db
    .select({ n: count() })
    .from(uploadTickets)
    .where(and(eq(uploadTickets.status, t.status), sql`(${uploadTickets.createdAt}, ${uploadTickets.id}) <= (select created_at, id from upload_tickets where id = ${t.id})`));
  return { id: t.id, state: t.status === 'granted' ? 'uploading' : 'waiting', position: p?.n ?? 1 };
}
