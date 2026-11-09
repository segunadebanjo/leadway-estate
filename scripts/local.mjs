// One-step local run: `npm run local` (or double-click the Start file).
// Installs what's missing, starts a built-in PostgreSQL (no separate install),
// prepares the database, builds the website and opens it in the browser.
// Everything is kept in the local-data/ folder. Press Ctrl+C to stop.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'local-data');
const DB_DIR = path.join(DATA, 'db');
const SETTINGS = path.join(DATA, 'settings.json');
const FIRST_LOGIN = path.join(DATA, 'FIRST-SIGN-IN.txt');
const APP_PORT = Number(process.env.PORT || 4000);
const DB_PORT = Number(process.env.LOCAL_DB_PORT || 54329);
const APP_URL = `http://localhost:${APP_PORT}`;
const isWin = process.platform === 'win32';

const say = (msg = '') => console.log(msg);
const step = (msg) => say(`\n▶ ${msg}`);
function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (Number(process.versions.node.split('.')[0]) < 20) {
  fail(`Node.js 20 or newer is needed (you have ${process.versions.node}). Download the LTS version from https://nodejs.org`);
}

function run(cmd, args, opts = {}) {
  const { quiet, error, env, cwd = ROOT } = opts;
  const r = spawnSync(cmd, args, { cwd, stdio: quiet ? 'pipe' : 'inherit', shell: isWin, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    if (r.error) console.error(r.error.message);
    if (quiet) process.stderr.write(String(r.stdout || '') + String(r.stderr || ''));
    fail(error || `"${cmd} ${args.join(' ')}" failed`);
  }
  return r;
}

say('Leadway Estate – starting on this computer');

// 1. Install packages the first time (needs internet once).
for (const [dir, label] of [[ROOT, 'launcher'], [path.join(ROOT, 'server'), 'server'], [path.join(ROOT, 'client'), 'website']]) {
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    step(`Installing ${label} packages (first time only, needs internet; a few minutes)…`);
    run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: dir, error: `Could not install the ${label} packages. Check your internet connection and run this again.` });
  }
}

// 2. Settings kept between runs (secrets are created once, on this computer).
fs.mkdirSync(DATA, { recursive: true });
const firstRun = !fs.existsSync(SETTINGS);
const settings = firstRun
  ? { jwtSecret: crypto.randomBytes(48).toString('base64url'), dbPassword: crypto.randomBytes(18).toString('base64url') }
  : JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
if (firstRun) fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2), { mode: 0o600 });

// 3. Built-in database.
step('Starting the database…');
const { default: EmbeddedPostgres } = await import('embedded-postgres');
const pg = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  port: DB_PORT,
  user: 'postgres',
  password: settings.dbPassword,
  persistent: true,
  // Postgres refuses to run as the "root" user (only happens in containers).
  createPostgresUser: typeof process.getuid === 'function' && process.getuid() === 0,
  onLog: () => {},
  onError: (e) => process.env.DEBUG && console.error(e),
});
const freshDb = !fs.existsSync(path.join(DB_DIR, 'PG_VERSION'));
try {
  if (freshDb) await pg.initialise();
  await pg.start();
} catch (err) {
  fail(`The database could not start (${err?.message || err}).\nIf another copy of the app is already running, close it first. Otherwise delete the folder ${DB_DIR} only if you have no data you need.`);
}
// Always try: a first run interrupted after initialise must still get its database.
await pg.createDatabase('leadway_estate').catch(() => {});

let server;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  say('\nStopping…');
  if (server && server.exitCode === null) server.kill('SIGTERM');
  await pg.stop().catch(() => {});
  say('Stopped. Your data is saved in the local-data folder.');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const env = {
  DATABASE_URL: `postgresql://postgres:${encodeURIComponent(settings.dbPassword)}@127.0.0.1:${DB_PORT}/leadway_estate`,
  JWT_SECRET: settings.jwtSecret,
  APP_URL,
  PORT: String(APP_PORT),
  NODE_ENV: 'development',
};

try {
  // 4. Tables (safe every time: only new changes are applied).
  step('Preparing the database…');
  run('npx', ['prisma', 'migrate', 'deploy'], { cwd: path.join(ROOT, 'server'), env, quiet: true, error: 'Could not prepare the database tables.' });

  // 5. First admin, once.
  if (!fs.existsSync(FIRST_LOGIN)) {
    const password = `Lwe-${crypto.randomBytes(4).toString('hex')}-${crypto.randomInt(10, 99)}`;
    const email = 'admin@leadwayestate.ng';
    const r = run('node', ['prisma/seed.js'], { cwd: path.join(ROOT, 'server'), env: { ...env, SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: password }, quiet: true });
    const created = String(r.stdout).includes('First admin created');
    fs.writeFileSync(
      FIRST_LOGIN,
      created
        ? `Leadway Estate – first sign-in\n\nAddress:  ${APP_URL}\nEmail:    ${email}\nPassword: ${password}\n\nYou will be asked to choose your own password straight away.\nAfter that, this temporary password no longer works.\n`
        : `An admin account already existed, so no new one was created.\nAddress: ${APP_URL}\n`,
    );

    // Optional sample data on the very first run.
    if (created && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question('\nLoad sample residents, bills and payments to try the app? (y/N) ')).trim().toLowerCase();
      rl.close();
      if (answer === 'y' || answer === 'yes') {
        step('Loading sample data…');
        run('node', ['prisma/demo.js'], { cwd: path.join(ROOT, 'server'), env, quiet: true });
        fs.appendFileSync(FIRST_LOGIN, `\nSample residents use the password Resident123,\ne.g. adebayo.ogunleye@example.com (resident) or gate@example.com (security).\n`);
      }
    }
  }

  // 6. Build the website when its source has changed.
  const dist = path.join(ROOT, 'client', 'dist', 'index.html');
  const newest = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((m, d) => {
      const p = path.join(dir, d.name);
      return Math.max(m, d.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    }, 0);
  if (!fs.existsSync(dist) || fs.statSync(dist).mtimeMs < newest(path.join(ROOT, 'client', 'src'))) {
    step('Building the website…');
    run('npm', ['run', 'build'], { quiet: true, error: 'Could not build the website.' });
  }
} catch (err) {
  console.error(err);
  await shutdown(1);
}

// 7. Start the app and open the browser.
step('Starting the app…');
server = spawn(process.execPath, ['src/server.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.on('data', (b) => process.env.DEBUG && process.stdout.write(b));
server.on('exit', (code) => {
  if (!stopping) {
    console.error(`\n✖ The app stopped unexpectedly (code ${code}). If it says the port is in use, close the other copy, or another program using port ${APP_PORT}.`);
    shutdown(1);
  }
});

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${APP_URL}/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

say(`\n✔ Leadway Estate is running at ${APP_URL}`);
say(`  First sign-in details: ${FIRST_LOGIN}`);
if (fs.existsSync(FIRST_LOGIN)) say('\n' + fs.readFileSync(FIRST_LOGIN, 'utf8').replace(/^/gm, '  '));
say('  Keep this window open while you use the app. Press Ctrl+C (or close the window) to stop.\n');

if (!process.env.NO_BROWSER) {
  const opener = isWin ? ['cmd', ['/c', 'start', '', APP_URL]] : process.platform === 'darwin' ? ['open', [APP_URL]] : ['xdg-open', [APP_URL]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
