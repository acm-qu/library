// Cron entry (hourly): node cleanup.mjs >> ~/logs/cleanup.log 2>&1
import { createDb } from '@acm/core/db';
import { cleanup } from './cleanup.ts';
import { cfg } from './config.ts';
import { log } from './log.ts';

const { db, pool } = createDb(cfg.DATABASE_URL, 1);
try {
  await cleanup({ db, cfg, log });
} catch (err) {
  log.error({ err }, 'cleanup crashed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
