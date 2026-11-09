// `prisma migrate deploy`, after tidying DATABASE_URL (a pooled Neon address
// or one pasted with quotes still works: see src/lib/dbUrl.js).
import { spawnSync } from 'node:child_process';
import { fixDatabaseUrlEnv } from '../src/lib/dbUrl.js';

fixDatabaseUrlEnv();
const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
process.exit(r.status ?? 1);
