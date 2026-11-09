import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertLedgerConsistent, invoiceFor, login, outbox, prisma, setup } from './helpers.js';

let ctx;
let u;
beforeEach(async () => {
  ctx = await setup({ residents: 2 });
  u = ctx.residents[0];
});
after(() => prisma.$disconnect());

const receive = (body) => ctx.adminAgent.post('/api/payments/receive', { method: 'CASH', paidAt: '2026-11-02', ...body });

test('a payment settles the oldest invoices first; preview matches what is recorded', async () => {
  const jan = await invoiceFor(u.id, 500_000, { dueDate: '2026-01-15' });
  const feb = await invoiceFor(u.id, 500_000, { dueDate: '2026-02-15' });
  const mar = await invoiceFor(u.id, 500_000, { dueDate: '2026-03-15' });
  const preview = await ctx.adminAgent.post('/api/payments/preview', { userId: u.id, amount: 800_000 });
  assert.deepEqual(preview.body.lines.map((l) => [l.invoiceId, l.amount]), [[jan.id, 500_000], [feb.id, 300_000]]);
  assert.equal(preview.body.credit, 0);

  const r = await receive({ userId: u.id, amount: 800_000, reference: 'TRF-001' });
  assert.equal(r.status, 201);
  assert.match(r.body.payment.receiptNo, /^LWE-\d{8}-[A-Z0-9]{6}$/);
  const after = await prisma.invoice.findMany({ where: { userId: u.id }, orderBy: { id: 'asc' } });
  assert.deepEqual(after.map((i) => [i.status, i.amountPaid]), [['PAID', 500_000], ['PARTIAL', 300_000], ['UNPAID', 0]]);
  assert.equal(after[2].id, mar.id);
  assert.equal(outbox.email.at(-1).to, u.email, 'e-receipt emailed');
  assert.ok(await prisma.notification.findFirst({ where: { userId: u.id, title: { startsWith: 'Payment received' } } }));
  await assertLedgerConsistent(assert);
});

test('a chosen invoice is settled first; the excess is kept as account credit', async () => {
  await invoiceFor(u.id, 500_000, { dueDate: '2026-01-15' });
  const big = await invoiceFor(u.id, 4_000_000, { dueDate: '2026-02-15' });
  const r = await receive({ userId: u.id, amount: 5_000_000, invoiceId: big.id });
  assert.equal(r.status, 201);
  assert.equal(r.body.credit, 500_000);
  assert.deepEqual(r.body.payment.allocations.map((a) => a.invoiceId)[0], big.id);
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).creditBalance, 500_000);
  await assertLedgerConsistent(assert);
});

test('a bank reference can be used once only', async () => {
  await invoiceFor(u.id, 500_000);
  assert.equal((await receive({ userId: u.id, amount: 100_000, reference: 'REF-9' })).status, 201);
  const dup = await receive({ userId: ctx.residents[1].id, amount: 100_000, reference: 'REF-9' });
  assert.equal(dup.status, 409);
});

test('validation: no zero, negative, fractional, future-dated or admin payments', async () => {
  for (const amount of [0, -5, 10.5, '100']) assert.equal((await receive({ userId: u.id, amount })).status, 400, `amount ${amount}`);
  assert.equal((await receive({ userId: u.id, amount: 1000, paidAt: '2099-01-01' })).status, 400);
  assert.equal((await receive({ userId: ctx.admin.id, amount: 1000 })).status, 400);
  assert.equal((await receive({ userId: u.id, amount: 1000, method: 'ACCOUNT_CREDIT' })).status, 400);
});

test('simultaneous receipts for one member never over-settle an invoice', async () => {
  await invoiceFor(u.id, 500_000);
  await invoiceFor(u.id, 500_000, { dueDate: '2026-02-15' });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => receive({ userId: u.id, amount: 300_000, reference: `C-${i}` })));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.body.error)));
  const inv = await prisma.invoice.findMany({ where: { userId: u.id } });
  assert.ok(inv.every((i) => i.status === 'PAID'));
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).creditBalance, 1_800_000 - 1_000_000);
  await assertLedgerConsistent(assert);
});

test('reversing a payment restores the invoices and takes back its credit', async () => {
  const inv = await invoiceFor(u.id, 500_000);
  const r = await receive({ userId: u.id, amount: 700_000 });
  const rev = await ctx.adminAgent.post(`/api/payments/${r.body.payment.id}/reverse`, { reason: 'Cheque bounced' });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.status, 'REVERSED');
  const fresh = await prisma.invoice.findUnique({ where: { id: inv.id } });
  assert.equal(fresh.status, 'UNPAID');
  assert.equal(fresh.amountPaid, 0);
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).creditBalance, 0);
  assert.equal((await ctx.adminAgent.post(`/api/payments/${r.body.payment.id}/reverse`, { reason: 'again' })).status, 409);
  await assertLedgerConsistent(assert);
});

test('reversing a payment whose credit was spent also undoes the credit application', async () => {
  const r = await receive({ userId: u.id, amount: 500_000 }); // nothing owed: all credit
  await ctx.adminAgent.post('/api/ledger/invoices/assign', { feeTypeId: (await prisma.feeType.findFirst()).id, userIds: [u.id], dueDate: '2026-12-01', amount: 500_000 });
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).creditBalance, 0, 'credit was applied to the new bill');
  const rev = await ctx.adminAgent.post(`/api/payments/${r.body.payment.id}/reverse`, { reason: 'mistake' });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const creditReceipt = await prisma.payment.findFirst({ where: { userId: u.id, method: 'ACCOUNT_CREDIT' } });
  assert.equal(creditReceipt.status, 'REVERSED');
  assert.equal((await ctx.adminAgent.get(`/api/residents/${u.id}`)).body.balance.outstanding, 500_000, 'the bill owes again');
  await assertLedgerConsistent(assert);
});

test('only an untouched invoice can be voided', async () => {
  const a = await invoiceFor(u.id, 500_000);
  const b = await invoiceFor(u.id, 500_000, { dueDate: '2026-02-15' });
  await receive({ userId: u.id, amount: 100_000 });
  assert.equal((await ctx.adminAgent.post(`/api/ledger/invoices/${a.id}/void`, { reason: 'x' })).status, 409);
  assert.equal((await ctx.adminAgent.post(`/api/ledger/invoices/${b.id}/void`, { reason: 'Billed in error' })).status, 200);
  const owed = await ctx.adminAgent.get(`/api/residents/${u.id}`);
  assert.equal(owed.body.balance.outstanding, 400_000, 'voided invoice no longer owed');
});

test('receipts are visible to their member and admins only', async () => {
  await invoiceFor(u.id, 500_000);
  const p = (await receive({ userId: u.id, amount: 500_000 })).body.payment;
  const mine = await login(u);
  const other = await login(ctx.residents[1]);
  assert.equal((await mine.get(`/api/payments/${p.id}`)).status, 200);
  assert.equal((await other.get(`/api/payments/${p.id}`)).status, 404);
  assert.equal((await ctx.adminAgent.get(`/api/payments/${p.id}`)).status, 200);
});

test('assigning a one-off fee to chosen residents; a period label prevents duplicates', async () => {
  const ft = (await ctx.adminAgent.post('/api/ledger/fee-types', { name: 'Electricity Connection Fee', amount: 2_500_000, frequency: 'ONE_OFF' })).body;
  const body = { feeTypeId: ft.id, userIds: ctx.residents.map((r) => r.id), dueDate: '2026-12-31', period: '2026-ECF' };
  assert.deepEqual((await ctx.adminAgent.post('/api/ledger/invoices/assign', body)).body, { created: 2, duplicates: 0 });
  assert.deepEqual((await ctx.adminAgent.post('/api/ledger/invoices/assign', body)).body, { created: 0, duplicates: 2 });
});

test('manual credit adjustment is applied to open bills', async () => {
  await invoiceFor(u.id, 500_000);
  const r = await ctx.adminAgent.post(`/api/residents/${u.id}/credit-adjustment`, { amount: 200_000, note: 'Goodwill' });
  assert.equal(r.status, 200);
  const inv = await prisma.invoice.findFirst({ where: { userId: u.id } });
  assert.equal(inv.amountPaid, 200_000);
  assert.equal((await ctx.adminAgent.post(`/api/residents/${u.id}/credit-adjustment`, { amount: -1, note: 'x' })).status, 400, 'credit cannot go negative');
  await assertLedgerConsistent(assert);
});
