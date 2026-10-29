// Entry point. Under Passenger, `listen` is intercepted and the app is reached through Apache.
import { assertServerVersion, createDb } from '@acm/core/db';
import { buildApp } from './app.ts';
import { cfg } from './config.ts';

const { db, pool } = createDb(cfg.DATABASE_URL, 10);
await assertServerVersion(pool);
const app = await buildApp({ cfg, db });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: cfg.PORT, host: '127.0.0.1' });
