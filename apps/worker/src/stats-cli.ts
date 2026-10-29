// Cron entry (nightly): node stats.mjs >> ~/logs/stats.log 2>&1
import { createDb } from '@acm/core/db';
import { cfg } from './config.ts';
import { log } from './log.ts';
import { storageStats } from './stats.ts';

const { db, pool } = createDb(cfg.DATABASE_URL, 1);
try {
  await storageStats({ db, cfg, log });
} catch (err) {
  log.error({ err }, 'stats crashed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
