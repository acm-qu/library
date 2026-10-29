// Vitest global setup: a fresh acm_media_test database on the docker Postgres 9.6, migrated once per run.
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from '../../packages/core/src/db/client.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://acm:acm@127.0.0.1:55496/acm_media_test';

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(`test database unreachable at ${url.host} — run \`npm run db:up\` (${(e as Error).message})`);
  }
  await admin.query(`drop database if exists "${name}"`);
  await admin.query(`create database "${name}"`);
  await admin.end();
  const { db, pool } = createDb(TEST_DATABASE_URL, 1);
  await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../migrations'), migrationsSchema: 'public' });
  await pool.end();
}
