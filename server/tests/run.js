// Runs the API test suite against a throwaway Postgres database.
// DATABASE_URL must name a database containing "test": it is wiped.
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL || '';
if (!/test/i.test(new URL(url || 'postgresql://x/none').pathname)) {
  console.error('Refusing to run: DATABASE_URL must point at a database whose name contains "test" (it is wiped).');
  process.exit(1);
}
const env = {
  ...process.env,
  NODE_ENV: 'test',
  JWT_SECRET: process.env.JWT_SECRET || 'test-secret-test-secret-test-secret-0123456789',
  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY || 'sk_test_x',
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(dir, 'uploads-test'),
  APP_URL: 'http://localhost:5173',
};
execSync('npx prisma migrate deploy', { cwd: path.join(dir, '..'), env, stdio: 'inherit' });
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
const only = process.argv.slice(2);
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...(only.length ? only : files)], { env, stdio: 'inherit' });
fs.rmSync(env.UPLOAD_DIR, { recursive: true, force: true });
process.exit(r.status ?? 1);
