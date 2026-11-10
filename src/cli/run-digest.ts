/**
 * Run one digest immediately and exit. Useful for testing, and for driving the
 * schedule from an external cron instead of the in-process scheduler
 * (set ENABLE_SCHEDULER=false and invoke this).
 */
import { migrate } from '../db/index.js';
import { runDigest } from '../services/digest.js';
import { log } from '../util/logger.js';

migrate();

runDigest()
  .then((summary) => {
    log.info('digest complete', summary);
    process.exit(0);
  })
  .catch((error: unknown) => {
    log.error('digest failed', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    process.exit(1);
  });
