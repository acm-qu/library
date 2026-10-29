// Apply migrations/ with drizzle's migrator. Used locally (`npm run db:migrate`) and on the server, where
// it is bundled by esbuild into the release as migrate.mjs and run before the `current` symlink flips.
// Migrations are additive only, so the previous release keeps working if the flip is rolled back.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { assertServerVersion, createDb } from '@acm/core/db';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const here = path.dirname(fileURLToPath(import.meta.url));
// Bundled (release/migrate.mjs) the folder sits beside the script; from the repo it is ../migrations.
const migrationsFolder = process.env.MIGRATIONS_DIR ?? [path.resolve(here, 'migrations'), path.resolve(here, '../migrations')].find((d) => existsSync(path.join(d, 'meta/_journal.json')))!;

const { db, pool } = createDb(url, 1);
try {
  const v = await assertServerVersion(pool);
  await migrate(db, { migrationsFolder, migrationsSchema: 'public', migrationsTable: '__drizzle_migrations' });
  console.log(`migrations applied (server ${v}, from ${migrationsFolder})`);
} finally {
  await pool.end();
}
