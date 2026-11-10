import { config } from './config.js';
import { log } from './util/logger.js';
import { migrate } from './db/index.js';
import { createApp } from './server/app.js';
import { startScheduler } from './jobs/scheduler.js';
import { adminExists } from './services/admin.js';
import { verifyMailer } from './services/mailer.js';
import { summariserName } from './services/summarise.js';

migrate();

if (!adminExists()) {
  log.warn('no admin password is set; run "npm run admin:password" before using the console');
}

const app = createApp();

const server = app.listen(config.PORT, () => {
  log.info('server listening', {
    port: config.PORT,
    baseUrl: config.BASE_URL,
    adminPath: config.ADMIN_PATH,
    summariser: summariserName(),
    mailProvider: config.MAIL_PROVIDER,
    timezone: config.TZ,
  });
});

void verifyMailer();
startScheduler();

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  // Do not hang indefinitely on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', {
    reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});
