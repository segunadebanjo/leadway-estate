import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, invoiceFor, login, outbox, prisma, setup, assertLedgerConsistent } from './helpers.js';
import { addMonths, progressOf, scheduleFor } from '../src/services/plans.js';
import { dueForAutomatic, runAutomaticReminders } from '../src/services/reminders.js';
import { todayIso, addDays } from '../src/lib/dates.js';

after(() => prisma.$disconnect());

const upload = (agent, url, buf, name, fields = {}) => {
  let r = agent.raw.post(url).set('X-Requested-With', 'fetch');
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', buf, name);
};
const csv = (lines) => Buffer.from(lines.join('\r\n'));

test('bank statement upload: matched by LWE number, phone or name; debits ignored; never received twice', async () => {
  const ctx = await setup({ residents: 0 });
  const ada = await createUser({ firstName: 'Adaeze', lastName: 'Okafor', phone: '08031234567' });
  const tunde = await createUser({ firstName: 'Tunde', lastName: 'Bello', phone: '08059876543' });
  const chidi = await createUser({ firstName: 'Chidi', lastName: 'Eze' });
  await invoiceFor(ada.id, 500_000);
  const file = csv([
    'Trans Date,Narration,Reference,Debit,Credit,Balance',
    `03/11/2026,NIP TRF Nov dues ${ada.membershipId},NIP001,,"5,000.00",10000`,
    '03/11/2026,Bank charges,CHG1,50.00,,9950',
    '04/11/2026,TRF FROM 08059876543,NIP002,,15000,24950',
    '05/11/2026,TRANSFER FROM CHIDI EZE,NIP003,,2000,26950',
    '05/11/2026,TRANSFER FROM UNKNOWN PERSON,NIP004,,3000,29950',
    `06/11/2026,LWE-0999 dues,NIP005,,1000,30950`,
  ]);
  const check = await upload(ctx.adminAgent, '/api/payments/import', file, 'statement.csv');
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.ready.map((r) => [r.membershipId, r.amount, r.matchedBy]), [
    [ada.membershipId, 500_000, 'Membership ID'],
    [tunde.membershipId, 1_500_000, 'Phone number'],
    [chidi.membershipId, 200_000, 'Name'],
  ]);
  assert.equal(check.body.notMoneyIn, 1);
  assert.deepEqual(check.body.errors.map((e) => e.row), [6, 7]);
  assert.match(check.body.errors[1].message, /No member LWE-0999/);
  assert.equal(await prisma.payment.count(), 0);

  const add = await upload(ctx.adminAgent, '/api/payments/import', file, 'statement.csv', { dryRun: 'false' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.created.length, 3);
  const adaInv = await prisma.invoice.findFirst({ where: { userId: ada.id } });
  assert.equal(adaInv.status, 'PAID', 'the payment settles the bill');
  assert.equal((await prisma.user.findUnique({ where: { id: tunde.id } })).creditBalance, 1_500_000, 'nothing owed, so kept as credit');
  assert.ok(await prisma.notification.findFirst({ where: { userId: tunde.id, title: { startsWith: 'Payment received' } } }));

  const again = await upload(ctx.adminAgent, '/api/payments/import', file, 'statement.csv', { dryRun: 'false' });
  assert.equal(again.body.created.length, 0);
  assert.equal(again.body.skipped.length, 3);
  // Without references: same member, day and amount counts as already received.
  const noRef = csv(['Date,Amount,Membership ID', `03/11/2026,5000,${ada.membershipId}`]);
  assert.equal((await upload(ctx.adminAgent, '/api/payments/import', noRef, 'p.csv')).body.skipped.length, 1);
  await assertLedgerConsistent(assert);
});

test('payment plans: schedule, progress from payments, completion, one active plan per member', async () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.deepEqual(scheduleFor(1000, 3, '2026-12-01').map((s) => [s.dueDate, s.amount]), [['2026-12-01', 333], ['2027-01-01', 333], ['2027-02-01', 334]]);
  const p = { totalAmount: 900, instalments: 3, firstDueDate: new Date('2026-01-10T00:00:00Z') };
  const pr = progressOf(p, 400, '2026-02-15');
  assert.deepEqual(pr.schedule.map((s) => s.state), ['PAID', 'PART_PAID', 'UPCOMING']);
  assert.equal(pr.behind, 200);
  assert.equal(pr.remaining, 500);

  const ctx = await setup({ residents: 1 });
  const [res] = ctx.residents;
  await invoiceFor(res.id, 3_000_000, { dueDate: '2026-01-15' });
  const first = addDays(todayIso(), 10);
  const preview = await ctx.adminAgent.post('/api/plans/preview', { userId: res.id, instalments: 3, firstDueDate: first });
  assert.equal(preview.body.totalAmount, 3_000_000);
  const r = await ctx.adminAgent.post('/api/plans', { userId: res.id, instalments: 3, firstDueDate: first });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.schedule.length, 3);
  assert.equal(r.body.behind, 0);
  assert.equal((await ctx.adminAgent.post('/api/plans', { userId: res.id, instalments: 2, firstDueDate: first })).status, 409);
  assert.ok(outbox.email.some((e) => /payment plan/.test(e.subject)));

  const agent = await login(res);
  assert.equal((await agent.get('/api/me/summary')).body.plan.remaining, 3_000_000);
  assert.equal((await agent.get('/api/plans')).status, 403, 'residents cannot manage plans');

  await ctx.adminAgent.post('/api/payments/receive', { userId: res.id, amount: 3_000_000, method: 'CASH', paidAt: todayIso() });
  const done = await ctx.adminAgent.get('/api/plans?status=ALL');
  assert.equal(done.body.rows[0].status, 'COMPLETED');
  assert.equal((await agent.get('/api/me/summary')).body.plan, null);
});

test('reminders: list who owes, send by app and email, plan members keeping up are left out of the weekly run', async () => {
  const ctx = await setup({ residents: 0 });
  const owes = await createUser({ firstName: 'Owes', lastName: 'Money', phone: '08030000001' });
  const onPlan = await createUser({ firstName: 'On', lastName: 'Plan' });
  const fine = await createUser({ firstName: 'All', lastName: 'Paid' });
  await invoiceFor(owes.id, 500_000, { dueDate: '2026-01-15' });
  await invoiceFor(onPlan.id, 500_000, { dueDate: '2026-01-15' });
  await invoiceFor(fine.id, 500_000, { dueDate: addDays(todayIso(), 5) }); // not due yet
  await ctx.adminAgent.post('/api/plans', { userId: onPlan.id, instalments: 2, firstDueDate: addDays(todayIso(), 20) });

  const list = await ctx.adminAgent.get('/api/admin/reminders');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.debtors.map((d) => d.membershipId).sort(), [owes.membershipId, onPlan.membershipId].sort());
  assert.deepEqual(list.body.debtors.filter((d) => d.inNextAutoRun).map((d) => d.id), [owes.id]);

  outbox.email.length = 0;
  outbox.sms.length = 0;
  const sent = await ctx.adminAgent.post('/api/admin/reminders/send', { userIds: [owes.id], email: true, sms: true });
  assert.deepEqual(sent.body, { reminded: 1, emailSent: 1, emailFailed: 0, smsSent: 1, smsFailed: 0 });
  assert.match(outbox.email[0].text, /₦5,000\.00 overdue/);
  assert.ok(await prisma.notification.findFirst({ where: { userId: owes.id, title: { startsWith: 'Reminder' } } }));
  assert.equal(await prisma.reminderLog.count(), 1);

  // Reminded a moment ago, so the weekly run skips them.
  const after = (await ctx.adminAgent.get('/api/admin/reminders')).body;
  assert.equal(after.debtors.filter((d) => d.inNextAutoRun).length, 0);
  assert.equal(dueForAutomatic(after.debtors, { ...after.settings, minDaysOverdue: 0 }, new Date(Date.now() + 7 * 86_400_000)).length, 1, 'a week later they are due again');

  // Automatic run: off by default, then on for today's weekday.
  assert.equal(await runAutomaticReminders(), null);
  const weekday = new Date(`${todayIso()}T12:00:00Z`).getUTCDay();
  const saved = await ctx.adminAgent.raw.put('/api/admin/reminders/settings').set('X-Requested-With', 'fetch').send({ auto: true, weekday, minDaysOverdue: 0, minAmount: 0, email: true, sms: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await prisma.reminderLog.deleteMany();
  const auto = await runAutomaticReminders();
  assert.equal(auto.reminded, 1);
  assert.equal((await prisma.reminderLog.findFirst()).automatic, true);

  const status = await ctx.adminAgent.get('/api/admin/settings/status');
  assert.equal(status.body.email.configured, false);
  assert.equal((await ctx.adminAgent.post('/api/admin/settings/test-email', { to: 'x@y.ng' })).status, 400);
});

test('assets upload: categories, opening stock, duplicates skipped', async () => {
  const ctx = await setup({ residents: 0 });
  const file = csv([
    'Item,Category,Qty,Unit,Re-order level,Location,Purchase cost',
    'Generator 60kVA,Equipment,1,pcs,,Power house,"8,500,000"',
    'Diesel,consumables,400,litres,100,Power house,',
    'Chlorine,Chemicals,3,bags,,,',
    'Bulbs,Consumable,two,pcs,,,',
  ]);
  const check = await upload(ctx.adminAgent, '/api/assets/import', file, 'assets.csv');
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.ready.map((r) => [r.name, r.category, r.quantity]), [['Generator 60kVA', 'EQUIPMENT', 1], ['Diesel', 'CONSUMABLE', 400]]);
  assert.deepEqual(check.body.errors.map((e) => e.row), [4, 5]);
  const add = await upload(ctx.adminAgent, '/api/assets/import', file, 'assets.csv', { dryRun: 'false' });
  assert.equal(add.status, 201);
  const diesel = await prisma.asset.findFirst({ where: { name: 'Diesel' } });
  assert.equal(diesel.quantity, 400);
  assert.equal(diesel.minQuantity, 100);
  assert.equal(await prisma.stockMovement.count({ where: { assetId: diesel.id } }), 1);
  assert.equal((await prisma.asset.findFirst({ where: { name: 'Generator 60kVA' } })).purchaseCost, 850_000_000);
  assert.equal((await upload(ctx.adminAgent, '/api/assets/import', file, 'assets.csv', { dryRun: 'false' })).body.created.length, 0);
});

test('polls: one vote per eligible member, results hidden until closed; meetings: register and turnout', async () => {
  const ctx = await setup({ residents: 0 });
  const owner = await createUser({ occupancyType: 'OWNER' });
  const owner2 = await createUser({ occupancyType: 'OWNER' });
  const tenant = await createUser({ occupancyType: 'TENANT' });
  const closesOn = addDays(todayIso(), 7);
  const poll = await ctx.adminAgent.post('/api/community/polls', { title: 'Raise monthly dues to ₦7,500?', audience: 'OWNERS', closesOn, options: ['Yes', 'No'] });
  assert.equal(poll.status, 201, JSON.stringify(poll.body));
  const [yes, no] = poll.body.options;
  assert.equal(await prisma.notification.count({ where: { title: { startsWith: 'New poll' } } }), 2, 'owners only');

  const a = await login(owner);
  const t = await login(tenant);
  assert.equal((await t.get('/api/community/polls')).body.rows.length, 0, 'tenants do not see an owners-only poll');
  assert.equal((await t.post(`/api/community/polls/${poll.body.id}/vote`, { optionId: yes.id })).status, 403);
  const voted = await a.post(`/api/community/polls/${poll.body.id}/vote`, { optionId: yes.id });
  assert.equal(voted.status, 200, JSON.stringify(voted.body));
  assert.equal(voted.body.myOptionId, yes.id);
  assert.equal(voted.body.options[0].votes, null, 'no results while open');
  assert.equal((await a.post(`/api/community/polls/${poll.body.id}/vote`, { optionId: no.id })).status, 409);
  await (await login(owner2)).post(`/api/community/polls/${poll.body.id}/vote`, { optionId: no.id });
  const adminView = (await ctx.adminAgent.get('/api/community/polls')).body.rows[0];
  assert.deepEqual(adminView.options.map((o) => o.votes), [1, 1]);
  assert.equal(adminView.electorate, 2);

  await ctx.adminAgent.post(`/api/community/polls/${poll.body.id}/close`);
  const after = (await a.get('/api/community/polls')).body.rows[0];
  assert.equal(after.open, false);
  assert.deepEqual(after.options.map((o) => o.votes), [1, 1]);
  assert.equal((await (await login(owner2)).post(`/api/community/polls/${poll.body.id}/vote`, { optionId: yes.id })).status, 400);

  const m = await ctx.adminAgent.post('/api/community/meetings', { title: 'AGM 2026', startsAt: `${closesOn}T10:00`, location: 'Estate hall', agenda: '1. Accounts\n2. Dues' });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.equal(await prisma.notification.count({ where: { title: 'Meeting: AGM 2026' } }), 3);
  await ctx.adminAgent.post(`/api/community/meetings/${m.body.id}/attendance`, { userId: owner.id, present: true });
  const mark = await ctx.adminAgent.post(`/api/community/meetings/${m.body.id}/attendance`, { userId: tenant.id, present: true, proxyName: 'Mrs Eze' });
  assert.deepEqual(mark.body, { present: 2, eligible: 3, turnout: 66.7 });
  await ctx.adminAgent.post(`/api/community/meetings/${m.body.id}/attendance`, { userId: tenant.id, present: false });
  const reg = await ctx.adminAgent.get(`/api/community/meetings/${m.body.id}`);
  assert.equal(reg.body.present, 1);
  const csvOut = await ctx.adminAgent.get(`/api/community/meetings/${m.body.id}/register.csv`);
  assert.match(csvOut.text, /Membership ID/);
  assert.equal((await a.get('/api/community/meetings')).body.rows[0].iAttended, true);
  assert.equal((await a.get(`/api/community/meetings/${m.body.id}`)).status, 403);
});

test('household and vehicles: residents manage their own, plates are unique, the gate can look them up', async () => {
  const ctx = await setup({ residents: 2 });
  const [r1, r2] = ctx.residents;
  const a = await login(r1);
  const b = await login(r2);
  assert.equal((await a.post('/api/household/people', { name: 'Ngozi Ident0', relationship: 'Spouse', phone: '08030000099' })).status, 201);
  assert.equal((await a.post('/api/household/people', { name: 'X', relationship: 'Cousin' })).status, 400);
  const car = await a.post('/api/household/vehicles', { plateNumber: 'kja 123 ab', description: 'Black Toyota Camry' });
  assert.equal(car.status, 201);
  assert.equal(car.body.plateNumber, 'KJA 123 AB');
  const dup = await b.post('/api/household/vehicles', { plateNumber: 'KJA-123AB' });
  assert.equal(dup.status, 409);
  assert.doesNotMatch(dup.body.error, /LWE/, 'residents are not told whose car it is');
  assert.equal((await b.delete(`/api/household/vehicles/${car.body.id}`)).status, 404, 'cannot remove another household\'s car');

  const mine = await a.get('/api/household');
  assert.equal(mine.body.people.length, 1);
  assert.equal((await ctx.adminAgent.get(`/api/household?userId=${r1.id}`)).body.vehicles.length, 1);
  assert.equal((await ctx.adminAgent.post('/api/household/vehicles', { userId: r2.id, plateNumber: 'LND 777 XY' })).status, 201);

  const guard = await login(await createUser({ role: 'SECURITY' }));
  const byPlate = await guard.get('/api/visitors/lookup?q=KJA123');
  assert.equal(byPlate.status, 200);
  assert.equal(byPlate.body.vehicles[0].host.membershipId, r1.membershipId);
  const byName = await guard.get('/api/visitors/lookup?q=ngozi');
  assert.equal(byName.body.people[0].relationship, 'Spouse');
  assert.equal((await a.get('/api/visitors/lookup?q=KJA')).status, 403);
  assert.equal((await guard.get('/api/household')).status, 403);
});
