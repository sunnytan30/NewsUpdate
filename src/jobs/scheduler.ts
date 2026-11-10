import cron from 'node-cron';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { runDigest } from '../services/digest.js';
import { purgeExpiredSessions } from '../services/admin.js';
import { sendHour } from '../services/subscribers.js';

let running = false;

/**
 * Guard against overlapping runs. A sweep that has work to do can take several
 * minutes, and two concurrent runs would send duplicate emails.
 */
async function runGuarded(trigger: string, force = false): Promise<void> {
  if (running) {
    log.warn('skipping sweep: previous run still in progress', { trigger });
    return;
  }
  running = true;
  try {
    await runDigest({ force });
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
  if (!cron.validate(config.DIGEST_SWEEP_CRON)) {
    log.error('DIGEST_SWEEP_CRON is not a valid cron expression; scheduler not started', {
      value: config.DIGEST_SWEEP_CRON,
    });
    return;
  }

  // The sweep itself is timezone-agnostic: it just asks which subscribers have
  // reached their own send hour. A sweep with nobody due does no work, so it
  // can run often enough to serve offsets that are not whole hours.
  cron.schedule(config.DIGEST_SWEEP_CRON, () => void runGuarded('sweep'), {
    timezone: config.TZ,
  });

  // Hourly housekeeping of expired admin sessions.
  cron.schedule('17 * * * *', () => purgeExpiredSessions(), { timezone: config.TZ });

  log.info('scheduler started', {
    sweep: config.DIGEST_SWEEP_CRON,
    sendHourLocal: sendHour(),
    defaultTimezone: config.DEFAULT_TIMEZONE,
  });
}

export { runGuarded };
