import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { csrf, securityHeaders } from './middleware.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { noticePage } from './views.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  if (config.TRUST_PROXY) {
    // Needed for req.ip and secure-cookie detection behind a reverse proxy.
    app.set('trust proxy', 1);
  }

  app.use(securityHeaders);
  app.use(cookieParser());
  // Forms only: no JSON body parser is mounted, since nothing posts JSON.
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  app.use(csrf);

  // The admin console is mounted at an unguessable path from configuration.
  app.use(config.ADMIN_PATH, adminRouter);
  app.use('/', publicRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).type('html').send(
      noticePage({ title: 'Not found', message: 'That page does not exist.', kind: 'warn' }),
    );
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error('unhandled request error', {
      method: req.method,
      path: req.path,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    if (res.headersSent) return;
    res.status(500).type('html').send(
      noticePage({
        title: 'Something went wrong',
        message: 'An unexpected error occurred. Please try again.',
        kind: 'err',
      }),
    );
  });

  return app;
}
