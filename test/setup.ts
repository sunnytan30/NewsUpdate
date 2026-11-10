import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Configure the environment before any module reads it. config.ts validates on
 * import and exits the process if required values are missing, so this must run
 * first (vitest `setupFiles` guarantees that).
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsupdate-test-'));

process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(tmpDir, 'test.sqlite');
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_PATH = '/console-test-abcdef123456';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.TOKEN_SECRET = 'b'.repeat(64);
process.env.BASE_URL = 'https://news.example.test';
process.env.MAIL_PROVIDER = 'console';
process.env.SUMMARISER = 'extractive';
process.env.TZ = 'Asia/Singapore';
// Keep tests offline and fast.
process.env.FETCH_TIMEOUT_MS = '2000';
process.env.FETCH_HOST_DELAY_MS = '0';
delete process.env.ANTHROPIC_API_KEY;
