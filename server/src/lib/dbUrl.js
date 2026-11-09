// Accept the database address however it was copied from Neon (or elsewhere):
// with or without quotes or a leading "psql", pooled or direct, with or
// without channel_binding. Returns a direct connection string Prisma and
// `prisma migrate` both accept (migrations need a direct, non-pooled link).
export function normalizeDbUrl(raw) {
  if (!raw) return raw;
  let s = String(raw).trim().replace(/^psql\s+/i, '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (s.startsWith('postgres://')) s = `postgresql://${s.slice('postgres://'.length)}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return s; // leave it to Prisma to explain what is wrong
  }
  if (u.hostname.endsWith('.neon.tech')) {
    u.hostname = u.hostname.replace(/-pooler(?=\.)/, '');
    if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require');
  }
  u.searchParams.delete('channel_binding');
  u.searchParams.delete('pgbouncer');
  return u.toString();
}

/** Make process.env.DATABASE_URL usable before Prisma reads it. */
export function fixDatabaseUrlEnv(env = process.env) {
  if (env.DATABASE_URL) env.DATABASE_URL = normalizeDbUrl(env.DATABASE_URL);
  return env.DATABASE_URL;
}
