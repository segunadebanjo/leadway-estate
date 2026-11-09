import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, prisma, setup, assertLedgerConsistent } from './helpers.js';
import { runBilling } from '../src/services/billing.js';
import { recordPayment } from '../src/services/ledger.js';
import { transaction } from '../src/db.js';

let ctx;
beforeEach(async () => {
  ctx = await setup({ residents: 3 });
});
after(() => prisma.$disconnect());

const NOV_1 = new Date('2026-11-01T00:30:00+01:00');
const JAN_3 = new Date('2027-01-03T09:00:00+01:00');

test('monthly billing creates one invoice per active resident and is idempotent', async () => {
  const first = await runBilling(NOV_1);
  assert.equal(first.created, 3, 'three residents × monthly due (no annual fee outside January)');
  const again = await runBilling(new Date('2026-11-20T10:00:00+01:00'));
  assert.equal(again.created, 0);
  const inv = await prisma.invoice.findMany();
  assert.equal(inv.length, 3);
  assert.ok(inv.every((i) => i.period === '2026-11' && i.amount === 500_000));
  assert.equal(inv[0].dueDate.toISOString().slice(0, 10), '2026-11-15', 'due after the payment terms');
});

test('concurrent runs do not double-bill', async () => {
  const results = await Promise.all([runBilling(NOV_1), runBilling(NOV_1), runBilling(NOV_1)]);
  assert.equal(await prisma.invoice.count(), 3);
  assert.ok(results.every((r) => r === results[0]), 'concurrent callers share one run');
});

test('a run on the 1st of January also bills the annual development fee', async () => {
  await runBilling(JAN_3);
  const inv = await prisma.invoice.findMany({ include: { feeType: true } });
  assert.equal(inv.length, 6);
  assert.equal(inv.filter((i) => i.feeType.code === 'ANNUAL_DEV_FEE' && i.period === '2027' && i.amount === 4_000_000).length, 3);
});

test('admins, security staff and deactivated residents are never billed; a late joiner is caught up', async () => {
  await createUser({ role: 'SECURITY' });
  await prisma.user.update({ where: { id: ctx.residents[2].id }, data: { isActive: false } });
  await runBilling(NOV_1);
  assert.equal(await prisma.invoice.count(), 2);
  const late = await createUser();
  const r = await runBilling(new Date('2026-11-12T00:10:00+01:00'));
  assert.equal(r.created, 1);
  assert.equal(await prisma.invoice.count({ where: { userId: late.id } }), 1);
});

test('changing a fee amount affects future invoices only', async () => {
  await runBilling(NOV_1);
  const ft = await prisma.feeType.findUnique({ where: { code: 'MONTHLY_DUE' } });
  const r = await ctx.adminAgent.patch(`/api/ledger/fee-types/${ft.id}`, { amount: 750_000 });
  assert.equal(r.status, 200);
  await runBilling(new Date('2026-12-01T00:10:00+01:00'));
  const nov = await prisma.invoice.findMany({ where: { period: '2026-11' } });
  const dec = await prisma.invoice.findMany({ where: { period: '2026-12' } });
  assert.ok(nov.every((i) => i.amount === 500_000));
  assert.ok(dec.every((i) => i.amount === 750_000));
});

test('account credit is applied automatically to new bills', async () => {
  const u = ctx.residents[0];
  // ₦12,000 paid in advance with nothing owing: all of it becomes credit.
  await transaction((tx) => recordPayment(tx, { userId: u.id, amount: 1_200_000, method: 'CASH' }));
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).creditBalance, 1_200_000);
  await runBilling(NOV_1);
  await runBilling(new Date('2026-12-01T00:10:00+01:00'));
  await runBilling(new Date('2027-01-01T00:10:00+01:00')); // Jan due ₦5,000 + annual ₦40,000
  const inv = await prisma.invoice.findMany({ where: { userId: u.id }, orderBy: { id: 'asc' } });
  const by = Object.fromEntries(inv.map((i) => [i.period, i.status]));
  assert.equal(by['2026-11'], 'PAID');
  assert.equal(by['2026-12'], 'PAID');
  assert.deepEqual([by['2027-01'], by['2027']].sort(), ['PARTIAL', 'UNPAID']);
  const user = await prisma.user.findUnique({ where: { id: u.id } });
  assert.equal(user.creditBalance, 0);
  const partial = inv.find((i) => i.status === 'PARTIAL');
  assert.equal(partial.amountPaid, 200_000, '₦12,000 − ₦10,000 = ₦2,000 left for the next bill');
  const creditReceipts = await prisma.payment.count({ where: { userId: u.id, method: 'ACCOUNT_CREDIT' } });
  assert.ok(creditReceipts >= 3);
  await assertLedgerConsistent(assert);
});

test('Run billing now (admin endpoint) and audit entry', async () => {
  const r = await ctx.adminAgent.post('/api/ledger/billing/run');
  assert.equal(r.status, 200);
  assert.ok(r.body.created >= 3);
  assert.equal((await ctx.adminAgent.post('/api/ledger/billing/run')).body.created, 0);
  assert.equal(await prisma.auditLog.count({ where: { action: 'billing.run' } }), 2);
});
