/**
 * Run a digest sweep immediately and exit.
 *
 *   npm run digest:run              send to whoever is due in their own timezone
 *   npm run digest:run -- --force   send to every active subscriber regardless
 *
 * Without --force this is the external-cron entry point: set
 * ENABLE_SCHEDULER=false and invoke it on the same cadence as
 * DIGEST_SWEEP_CRON (every 15 minutes by default). A sweep with nobody due
 * costs one query and fetches nothing.
 */
import { migrate } from '../db/index.js';
import { runDigest } from '../services/digest.js';
import { log } from '../util/logger.js';

migrate();

const force = process.argv.includes('--force');

runDigest({ force })
  .then((summary) => {
    if (summary.subscribersConsidered === 0) {
      log.info('nobody due in this sweep', { force });
    } else {
      log.info('digest complete', summary);
    }
    process.exit(0);
  })
  .catch((error: unknown) => {
    log.error('digest failed', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    process.exit(1);
  });
