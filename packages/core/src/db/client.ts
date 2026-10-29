// One pg pool per process. Passenger runs a single API process; the worker opens its own small pool.
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export const MIN_SERVER_VERSION = 90500; // FOR UPDATE SKIP LOCKED

export function createDb(url: string, max = 5) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
export type Db = ReturnType<typeof createDb>['db'];

/** Refuse to boot against a server older than the features we rely on. */
export async function assertServerVersion(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ v: string }>("select current_setting('server_version_num') as v");
  const v = Number(rows[0]?.v);
  if (!(v >= MIN_SERVER_VERSION)) throw new Error(`PostgreSQL ${v} is older than ${MIN_SERVER_VERSION}`);
  return v;
}
