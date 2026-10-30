// Upload ticket expiry, shared by the API (every grant pass) and the worker's hourly cleanup.
import { sql } from 'drizzle-orm';
import type { Db } from './client.ts';

/** A granted ticket with no chunk and no poll for this long gives its slot back. */
export const GRANTED_IDLE_S = 120;
/** A waiting ticket whose browser stopped polling for this long leaves the line. */
export const WAITING_IDLE_S = 60;

export async function expireUploadTickets(db: Pick<Db, 'execute'>) {
  const r = await db.execute(sql`
    update upload_tickets set status = 'expired'
    where (status = 'granted' and last_seen_at < now() - ${GRANTED_IDLE_S} * interval '1 second')
       or (status = 'waiting' and last_seen_at < now() - ${WAITING_IDLE_S} * interval '1 second')`);
  return r.rowCount ?? 0;
}
