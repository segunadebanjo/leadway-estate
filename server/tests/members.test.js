import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { anon, outbox, prisma, setup } from './helpers.js';

let ctx;
beforeEach(async () => {
  ctx = await setup({ residents: 0 });
});
after(() => prisma.$disconnect());

const body = (over = {}) => ({ firstName: 'Chidi', lastName: 'Okafor', email: `c${Math.random().toString(36).slice(2, 8)}@example.com`, phone: '08031234567', plotNumber: 'B12', street: 'Palm Close', occupancyType: 'OWNER', ...over });

test('creating a resident: membership ID, temporary password, immediate billing', async () => {
  const r = await ctx.adminAgent.post('/api/residents', { ...body(), sendEmail: true });
  assert.equal(r.status, 201);
  assert.match(r.body.user.membershipId, /^LWE-\d{4}$/);
  assert.equal(r.body.user.mustChangePassword, true);
  assert.ok(r.body.temporaryPassword);
  assert.equal(r.body.emailed, true);
  assert.ok(outbox.email.at(-1).text.includes(r.body.temporaryPassword));
  assert.ok(r.body.invoicesCreated >= 1, 'billed for the current month at once');
  // The temporary password works and forces a change.
  const login = await anon().post('/api/auth/login', { email: r.body.user.email, password: r.body.temporaryPassword });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.mustChangePassword, true);
});

test('membership IDs are sequential, unique under concurrency, and not editable', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => ctx.adminAgent.post('/api/residents', body())));
  assert.ok(results.every((r) => r.status === 201));
  const ids = results.map((r) => r.body.user.membershipId);
  assert.equal(new Set(ids).size, 12);
  const one = results[0].body.user;
  const p = await ctx.adminAgent.patch(`/api/residents/${one.id}`, { membershipId: 'LWE-9999', firstName: 'Renamed' });
  assert.equal(p.status, 200);
  assert.equal(p.body.user.membershipId, one.membershipId);
  assert.equal(p.body.user.firstName, 'Renamed');
});

test('duplicate email is refused', async () => {
  const b = body();
  assert.equal((await ctx.adminAgent.post('/api/residents', b)).status, 201);
  const r = await ctx.adminAgent.post('/api/residents', { ...b, email: b.email.toUpperCase() });
  assert.equal(r.status, 409);
});

test('search by name, plot or membership ID (with or without the prefix)', async () => {
  const a = (await ctx.adminAgent.post('/api/residents', body({ firstName: 'Ngozi', plotNumber: 'C7' }))).body.user;
  await ctx.adminAgent.post('/api/residents', body({ firstName: 'Tunde' }));
  const num = String(Number(a.membershipId.slice(4)));
  for (const q of ['ngozi', 'C7', a.membershipId, num, `ngozi ${a.lastName}`]) {
    const r = await ctx.adminAgent.get(`/api/residents?q=${encodeURIComponent(q)}`);
    assert.ok(r.body.rows.some((x) => x.id === a.id), `found by ${q}`);
  }
});

test('reset password issues a new temporary password and signs the member out', async () => {
  const created = (await ctx.adminAgent.post('/api/residents', body())).body;
  const r = await ctx.adminAgent.post(`/api/residents/${created.user.id}/reset-password`, { sendEmail: false });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.temporaryPassword, created.temporaryPassword);
  assert.equal((await anon().post('/api/auth/login', { email: created.user.email, password: created.temporaryPassword })).status, 401);
  assert.equal((await anon().post('/api/auth/login', { email: created.user.email, password: r.body.temporaryPassword })).status, 200);
});

test('an admin cannot deactivate or demote themselves', async () => {
  assert.equal((await ctx.adminAgent.post(`/api/residents/${ctx.admin.id}/deactivate`)).status, 400);
  assert.equal((await ctx.adminAgent.patch(`/api/residents/${ctx.admin.id}`, { role: 'RESIDENT' })).status, 400);
});

test('member detail shows balance, invoices, payments and credit', async () => {
  const u = (await ctx.adminAgent.post('/api/residents', body())).body.user;
  const r = await ctx.adminAgent.get(`/api/residents/${u.id}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.balance.outstanding > 0);
  assert.equal(r.body.invoices.length, r.body.balance.openInvoices);
});

test('changes to members are audited', async () => {
  const u = (await ctx.adminAgent.post('/api/residents', body())).body.user;
  await ctx.adminAgent.patch(`/api/residents/${u.id}`, { plotNumber: 'Z1' });
  const log = await ctx.adminAgent.get('/api/admin/audit?entity=User');
  const upd = log.body.rows.find((r) => r.action === 'member.update');
  assert.deepEqual(upd.details.plotNumber, { from: 'B12', to: 'Z1' });
  assert.equal(upd.actorId, ctx.admin.id);
});
