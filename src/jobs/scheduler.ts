import cron from 'node-cron';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { runDigest } from '../services/digest.js';
import { purgeExpiredSessions } from '../services/admin.js';

let running = false;

/**
 * Guard against overlapping runs. A digest run can take several minutes, and
 * two concurrent runs would send duplicate emails.
 */
async function runGuarded(trigger: string): Promise<void> {
  if (running) {
    log.warn('skipping digest run: previous run still in progress', { trigger });
    return;
  }
  running = true;
  try {
    await runDigest();
  } catch (error) {
    log.error('scheduled digest run failed', {
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  if (!config.ENABLE_SCHEDULER) {
    log.info('scheduler disabled by configuration');
    return;
  }
  if (!cron.validate(config.DIGEST_CRON)) {
    log.error('DIGEST_CRON is not a valid cron expression; scheduler not started', {
      value: config.DIGEST_CRON,
    });
    return;
  }

  cron.schedule(config.DIGEST_CRON, () => void runGuarded('cron'), { timezone: config.TZ });

  // Hourly housekeeping of expired admin sessions.
  cron.schedule('17 * * * *', () => purgeExpiredSessions(), { timezone: config.TZ });

  log.info('scheduler started', { cron: config.DIGEST_CRON, timezone: config.TZ });
}

export { runGuarded };
