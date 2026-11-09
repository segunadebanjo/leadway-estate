import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertLedgerConsistent, createUser, prisma, setup } from './helpers.js';
import { loadDemoData } from '../prisma/demo.js';

after(() => prisma.$disconnect());

test('remove sample data: clears only the sample records, all of them, and numbering carries on from the real ones', async () => {
  const ctx = await setup({ residents: 0 });
  assert.equal((await ctx.adminAgent.get('/api/admin/sample-data')).body.loaded, null, 'nothing to remove yet');
  await loadDemoData();

  // Real records entered alongside the samples.
  const real = await ctx.adminAgent.post('/api/residents', { firstName: 'Real', lastName: 'Member', email: 'real.member@gmail.com', plotNumber: 'Z1', occupancyType: 'OWNER' });
  assert.equal(real.status, 201, JSON.stringify(real.body));
  const realId = real.body.user?.id ?? real.body.id;
  const pay = await ctx.adminAgent.post('/api/payments/receive', { userId: realId, amount: 1_000_000, method: 'CASH', paidAt: new Date().toISOString().slice(0, 10) });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  await ctx.adminAgent.post('/api/admin/expenses', { date: '2026-11-03', category: 'Security', description: 'Night guards', amount: 5_000_000 });
  const realDiesel = await prisma.asset.create({ data: { name: 'Diesel', category: 'CONSUMABLE', unit: 'litres', quantity: 10 } });
  await prisma.asset.update({ where: { id: realDiesel.id }, data: { createdAt: new Date(Date.now() + 3 * 3600_000) } });
  const realGuard = await createUser({ role: 'SECURITY', email: 'guard@leadway.ng' });

  const summary = (await ctx.adminAgent.get('/api/admin/sample-data')).body.loaded;
  assert.equal(summary.residents, 12);
  assert.equal(summary.securityStaff, 1);
  assert.equal(summary.assets, 4, 'the real Diesel entry, made later, is not counted');
  assert.equal(summary.expenses, 13);

  const resident = await prisma.user.findFirst({ where: { email: 'adebayo.ogunleye@example.com' } });
  const sampleAgent = await import('./helpers.js').then((h) => h.login(resident, 'Resident123'));
  assert.equal((await sampleAgent.post('/api/admin/sample-data/remove')).status, 403, 'residents cannot do this');

  const r = await ctx.adminAgent.post('/api/admin/sample-data/remove');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed.residents, 12);

  assert.equal(await prisma.user.count({ where: { email: { endsWith: '@example.com' }, id: { notIn: [ctx.admin.id] } } }), 0);
  assert.deepEqual((await prisma.user.findMany({ orderBy: { id: 'asc' }, select: { email: true } })).map((u) => u.email).filter((e) => !e.startsWith('u')), ['real.member@gmail.com', 'guard@leadway.ng']);
  assert.equal(await prisma.payment.count(), 1, 'the real payment stays');
  assert.equal(await prisma.invoice.count({ where: { userId: { not: realId } } }), 0);
  assert.deepEqual((await prisma.expense.findMany()).map((e) => e.description), ['Night guards']);
  assert.deepEqual((await prisma.asset.findMany()).map((a) => a.id), [realDiesel.id]);
  assert.equal(await prisma.stockMovement.count(), 0);
  assert.equal(await prisma.maintenanceLog.count(), 0);
  assert.equal(await prisma.serviceRequest.count(), 0);
  assert.equal(await prisma.visitorPass.count(), 0);
  assert.equal(await prisma.feeType.count({ where: { code: 'ELECTRICITY_CONNECTION' } }), 0);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'sampleData.remove' } }));
  await assertLedgerConsistent(assert);
  assert.equal(realGuard.role, 'SECURITY');

  // The next member is numbered straight after the highest real one.
  const highest = Math.max(...(await prisma.user.findMany({ select: { membershipId: true } })).map((u) => Number(u.membershipId.slice(4))));
  const next = await ctx.adminAgent.post('/api/residents', { firstName: 'Next', lastName: 'One', email: 'next.one@gmail.com', occupancyType: 'OWNER' });
  assert.equal((next.body.user ?? next.body).membershipId, `LWE-${String(highest + 1).padStart(4, '0')}`);

  assert.equal((await ctx.adminAgent.post('/api/admin/sample-data/remove')).status, 404, 'a second press finds nothing');
});

test('remove sample data: on a fresh demo with no real members, members start again from the admin', async () => {
  const ctx = await setup({ residents: 0 });
  await loadDemoData();
  assert.equal((await ctx.adminAgent.post('/api/admin/sample-data/remove')).status, 200);
  const next = await ctx.adminAgent.post('/api/residents', { firstName: 'First', lastName: 'Real', email: 'first.real@gmail.com', occupancyType: 'OWNER' });
  assert.equal((next.body.user ?? next.body).membershipId, 'LWE-0002', 'the admin is LWE-0001');
});
