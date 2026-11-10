/**
 * Set the administrator password.
 *
 *   npm run admin:password                 prompt for a password (not echoed)
 *   npm run admin:password -- --generate   generate a strong one and print it once
 *
 * The password is stored only as a scrypt hash. Setting it invalidates any
 * existing admin sessions.
 */
import crypto from 'node:crypto';
import readline from 'node:readline';
import { config } from '../config.js';
import { migrate } from '../db/index.js';
import { MIN_PASSWORD_LENGTH, setAdminPassword } from '../services/admin.js';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_=+.';

function generatePassword(length = 24): string {
  let out = '';
  while (out.length < length) {
    const byte = crypto.randomBytes(1)[0] as number;
    // Rejection sampling keeps the distribution uniform over the alphabet.
    const limit = 256 - (256 % ALPHABET.length);
    if (byte >= limit) continue;
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const input = process.stdin;

    // Suppress echo so the password is not shown or left in the scrollback.
    const onData = (char: Buffer | string) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') input.removeListener('data', onData);
    };
    process.stdout.write(question);
    const originalWrite = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
      if (s.includes('\n')) process.stdout.write('\n');
    };
    input.on('data', onData);

    rl.question('', (answer) => {
      if (originalWrite) {
        (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = originalWrite;
      }
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  migrate();

  const generate = process.argv.includes('--generate');
  let password: string;

  if (generate) {
    password = generatePassword();
  } else if (!process.stdin.isTTY) {
    // Allow piping, e.g. `echo "..." | npm run admin:password`.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    password = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    password = (await promptHidden(`New admin password (min ${MIN_PASSWORD_LENGTH} chars): `)).trim();
    const again = (await promptHidden('Confirm password: ')).trim();
    if (password !== again) {
      console.error('Passwords do not match. Nothing was changed.');
      process.exit(1);
    }
  }

  const result = setAdminPassword(password);
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }

  console.log('\nAdmin password set.');
  console.log(`  Sign in at : ${config.BASE_URL.replace(/\/+$/, '')}${config.ADMIN_PATH}`);
  console.log(`  Email      : ${config.ADMIN_EMAIL}`);
  if (generate) {
    console.log(`  Password   : ${password}`);
    console.log('\nStore it in a password manager now. It is not recoverable from the database.');
  }
  console.log('\nAny existing admin sessions have been signed out.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
