// Cron entry (every minute): /usr/bin/flock -n ~/tmp/worker.lock node worker.mjs >> ~/logs/worker.log 2>&1
import { assertServerVersion, createDb } from '@acm/core/db';
import { ioAllocPath } from '@acm/core/paths';
import { cfg } from './config.ts';
import { setAllocFile } from './lib/pace.ts';
import { log } from './log.ts';
import { runUntil } from './runner.ts';
import { storageStatsIfStale } from './stats.ts';

const { db, pool } = createDb(cfg.DATABASE_URL, 2);
setAllocFile(ioAllocPath(cfg.MEDIA_ROOT));
try {
  await assertServerVersion(pool);
  const n = await runUntil({ db, cfg, log });
  if (n) {
    log.info({ jobs: n }, 'tick finished');
    // Uploads and deletes change what's on disk; re-measure so Admin · Storage isn't a day behind.
    await storageStatsIfStale({ db, cfg, log });
  }
} catch (err) {
  log.error({ err }, 'worker crashed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
