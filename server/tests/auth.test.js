import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { app, anon, createUser, login, outbox, prisma, resetDb, PASSWORD } from './helpers.js';

before(resetDb);
after(() => prisma.$disconnect());

test('sign in, who am I, sign out', async () => {
  const u = await createUser();
  const a = await login(u);
  const me = await a.get('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, u.email);
  assert.equal(me.body.user.passwordHash, undefined);
  await a.post('/api/auth/logout');
  assert.equal((await a.get('/api/auth/me')).status, 401);
});

test('wrong password and unknown email give the same answer', async () => {
  const u = await createUser();
  const a = anon();
  const r1 = await a.post('/api/auth/login', { email: u.email, password: 'nope-nope-1' });
  const r2 = await a.post('/api/auth/login', { email: 'nobody@example.com', password: 'nope-nope-1' });
  assert.equal(r1.status, 401);
  assert.equal(r2.status, 401);
  assert.equal(r1.body.error, r2.body.error);
});

test('state-changing requests need the CSRF header', async () => {
  const u = await createUser();
  const res = await request(app).post('/api/auth/login').send({ email: u.email, password: PASSWORD });
  assert.equal(res.status, 403);
});

test('role isolation: residents and security cannot reach admin routes', async () => {
  const resident = await login(await createUser());
  const guard = await login(await createUser({ role: 'SECURITY' }));
  for (const path of ['/api/residents', '/api/ledger/invoices', '/api/payments', '/api/reports/collections', '/api/admin/dashboard', '/api/assets', '/api/broadcasts', '/api/admin/audit']) {
    assert.equal((await resident.get(path)).status, 403, `resident ${path}`);
    assert.equal((await guard.get(path)).status, 403, `security ${path}`);
    assert.equal((await anon().get(path)).status, 401, `anonymous ${path}`);
  }
  assert.equal((await resident.get('/api/visitors')).status, 403, 'resident cannot see the gate log');
  assert.equal((await guard.get('/api/visitors')).status, 200);
  assert.equal((await guard.get('/api/me/invoices')).status, 403, 'security staff have no ledger');
});

test('a temporary password must be changed before anything else', async () => {
  const u = await createUser({ mustChangePassword: true });
  const a = await login(u);
  assert.equal((await a.get('/api/me/summary')).status, 403);
  const bad = await a.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' });
  assert.equal(bad.status, 400);
  const ok = await a.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'NewPassw0rd!' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.mustChangePassword, false);
  assert.equal((await a.get('/api/me/summary')).status, 200, 'the re-issued cookie keeps the user signed in');
});

test('changing the password signs out other sessions', async () => {
  const u = await createUser();
  const a = await login(u);
  const b = await login(u);
  await a.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Another1Pass' });
  assert.equal((await b.get('/api/auth/me')).status, 401);
  assert.equal((await a.get('/api/auth/me')).status, 200);
});

test('self-service password reset: emailed single-use link', async () => {
  const u = await createUser();
  const old = await login(u);
  outbox.email.length = 0;
  const r = await anon().post('/api/auth/forgot-password', { email: u.email.toUpperCase() });
  assert.equal(r.status, 200);
  const unknown = await anon().post('/api/auth/forgot-password', { email: 'ghost@example.com' });
  assert.deepEqual(unknown.body, r.body, 'same answer for unknown emails');
  assert.equal(outbox.email.length, 1);
  const token = outbox.email[0].text.match(/token=([\w-]+)/)[1];
  assert.equal((await anon().post('/api/auth/reset-password', { token, newPassword: 'weak' })).status, 400);
  assert.equal((await anon().post('/api/auth/reset-password', { token, newPassword: 'Reset1Password' })).status, 200);
  assert.equal((await anon().post('/api/auth/reset-password', { token, newPassword: 'Reset2Password' })).status, 400, 'link is single use');
  assert.equal((await old.get('/api/auth/me')).status, 401, 'old sessions are signed out');
  await login(u, 'Reset1Password');
  const stored = await prisma.passwordResetToken.findMany({ where: { userId: u.id } });
  assert.ok(stored.every((t) => t.tokenHash !== token), 'only a hash is stored');
});

test('a deactivated member is signed out immediately and cannot sign in', async () => {
  const admin = await login(await createUser({ role: 'ADMIN' }));
  const u = await createUser();
  const a = await login(u);
  assert.equal((await admin.post(`/api/residents/${u.id}/deactivate`)).status, 200);
  assert.equal((await a.get('/api/auth/me')).status, 401);
  const r = await anon().post('/api/auth/login', { email: u.email, password: PASSWORD });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /deactivated/);
});
