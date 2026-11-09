import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceFor, prisma, setup, assertLedgerConsistent } from './helpers.js';
import { memberBalance } from '../src/services/ledger.js';
import { memberStatement } from '../src/routes/reports.js';

after(() => prisma.$disconnect());

const receive = (ctx, userId, amount, extra = {}) => ctx.adminAgent.post('/api/payments/receive', { userId, amount, method: 'BANK_TRANSFER', paidAt: '2026-11-02', ...extra });

/** The statement's closing balance must always agree with the ledger. */
async function assertStatementAgrees(userId) {
  const [st, b] = await Promise.all([memberStatement(userId), memberBalance(userId)]);
  assert.equal(st.closing, b.outstanding - b.credit, 'statement closing balance = outstanding − credit');
}

test('reverse a bill raised in error, even after part payment: the money moves to the other bills', async () => {
  const ctx = await setup({ residents: 1 });
  const [m] = ctx.residents;
  const wrong = await invoiceFor(m.id, 1_000_000, { dueDate: '2026-01-10', description: 'Charged in error' });
  const other = await invoiceFor(m.id, 500_000, { dueDate: '2026-02-10', description: 'Real bill' });
  await receive(ctx, m.id, 600_000);

  const r = await ctx.adminAgent.post(`/api/ledger/invoices/${wrong.id}/reverse`, { reason: 'Not a member that month' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.released, 600_000);
  const [w, o, u] = await Promise.all([prisma.invoice.findUnique({ where: { id: wrong.id } }), prisma.invoice.findUnique({ where: { id: other.id } }), prisma.user.findUnique({ where: { id: m.id } })]);
  assert.equal(w.status, 'VOID');
  assert.equal(w.amountPaid, 0);
  assert.equal(o.status, 'PAID', 'the freed ₦6,000 paid the real ₦5,000 bill');
  assert.equal(u.creditBalance, 100_000);

  const st = await memberStatement(m.id);
  assert.ok(st.rows.some((x) => x.type === 'Bill' && x.description === 'Charged in error' && x.debit === 1_000_000), 'original charge still shown');
  assert.ok(st.rows.some((x) => x.type === 'Reversal' && x.credit === 1_000_000 && /Not a member/.test(x.description)));
  await assertStatementAgrees(m.id);

  assert.equal((await ctx.adminAgent.post(`/api/ledger/invoices/${wrong.id}/reverse`, { reason: 'again' })).status, 409);
  await assertLedgerConsistent(assert);
});

test('lower a bill that was over-charged: the excess paid becomes credit', async () => {
  const ctx = await setup({ residents: 1 });
  const [m] = ctx.residents;
  const inv = await invoiceFor(m.id, 1_000_000);
  await receive(ctx, m.id, 1_000_000);
  const r = await ctx.adminAgent.post(`/api/ledger/invoices/${inv.id}/reverse`, { newAmount: 700_000, reason: 'Wrong rate' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await prisma.invoice.findUnique({ where: { id: inv.id } });
  assert.deepEqual([after.amount, after.amountPaid, after.status], [700_000, 700_000, 'PAID']);
  assert.equal((await prisma.user.findUnique({ where: { id: m.id } })).creditBalance, 300_000);
  const st = await memberStatement(m.id);
  assert.equal(st.rows.find((x) => x.type === 'Bill').debit, 1_000_000, 'shows the original charge');
  assert.equal(st.rows.find((x) => x.type === 'Reduction').credit, 300_000);
  await assertStatementAgrees(m.id);
  assert.equal((await ctx.adminAgent.post(`/api/ledger/invoices/${inv.id}/reverse`, { newAmount: 900_000, reason: 'x' })).status, 400, 'cannot raise a bill this way');
  await assertLedgerConsistent(assert);
});

test('reverse a payment whose credit was already used: the credit applications are undone too', async () => {
  const ctx = await setup({ residents: 1 });
  const [m] = ctx.residents;
  await invoiceFor(m.id, 500_000, { dueDate: '2026-01-10' });
  const pay = await receive(ctx, m.id, 1_500_000, { reference: 'WRONG-1' }); // ₦10,000 kept as credit
  // A new bill uses that credit.
  const ft = await prisma.feeType.findUnique({ where: { code: 'ANNUAL_DEV_FEE' } });
  await ctx.adminAgent.post('/api/ledger/invoices/assign', { feeTypeId: ft.id, userIds: [m.id], amount: 800_000, dueDate: '2026-12-01' });
  assert.equal((await prisma.user.findUnique({ where: { id: m.id } })).creditBalance, 200_000);

  const r = await ctx.adminAgent.post(`/api/payments/${pay.body.payment.id}/reverse`, { reason: 'Transfer bounced' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.undone.length, 1);
  const b = await memberBalance(m.id);
  assert.equal(b.outstanding, 1_300_000, 'both bills owe again');
  assert.equal(b.credit, 0);
  await assertStatementAgrees(m.id);
  await assertLedgerConsistent(assert);
});

test('move a payment from last year’s bills to this year’s debit note', async () => {
  const ctx = await setup({ residents: 1 });
  const [m] = ctx.residents;
  const old = await invoiceFor(m.id, 1_000_000, { dueDate: '2026-01-10', description: 'Security Fee – January 2026' });
  const security = await prisma.feeType.create({ data: { code: 'SECURITY_FEE', name: 'Security Fee', amount: 100_000, frequency: 'MONTHLY' } });
  const dn = await ctx.adminAgent.post('/api/debit-notes', { year: 2027, monthlyFeeTypeId: security.id, monthlyAmount: 100_000, issueDate: '2027-01-01', dueDate: '2027-01-31', notify: false });
  assert.equal(dn.status, 201, JSON.stringify(dn.body));
  const pay = await receive(ctx, m.id, 1_000_000, { reference: 'FOR-2027' });
  assert.equal((await prisma.invoice.findUnique({ where: { id: old.id } })).status, 'PAID', 'oldest first put it on 2026');

  const opts = await ctx.adminAgent.get(`/api/payments/${pay.body.payment.id}/move-options`);
  assert.equal(opts.status, 200);
  const noteLines = opts.body.bills.filter((b) => b.debitNote?.noteNo === 'DN-2027-0001').map((b) => b.id);
  assert.equal(noteLines.length, 12);
  assert.equal(opts.body.bills.find((b) => b.id === old.id).fromThisPayment, 1_000_000);

  const pv = await ctx.adminAgent.post(`/api/payments/${pay.body.payment.id}/move`, { invoiceIds: noteLines, dryRun: true });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.after.length, 10, '₦10,000 pays ten months of ₦1,000');
  assert.equal((await prisma.invoice.findUnique({ where: { id: old.id } })).status, 'PAID', 'preview changes nothing');

  const mv = await ctx.adminAgent.post(`/api/payments/${pay.body.payment.id}/move`, { invoiceIds: noteLines, reason: 'Member said it is for 2027' });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal((await prisma.invoice.findUnique({ where: { id: old.id } })).status, 'UNPAID');
  const note = (await ctx.adminAgent.get(`/api/debit-notes/${dn.body.notes[0].noteId}`)).body;
  assert.equal(note.paid, 1_000_000);
  assert.equal(note.balance, 200_000);
  await assertStatementAgrees(m.id);
  await assertLedgerConsistent(assert);
});

test('reverse a debit note after payments: paid money moves to other bills, the note can be issued again', async () => {
  const ctx = await setup({ residents: 1 });
  const [m] = ctx.residents;
  const security = await prisma.feeType.create({ data: { code: 'SECURITY_FEE', name: 'Security Fee', amount: 100_000, frequency: 'MONTHLY' } });
  const body = { year: 2027, monthlyFeeTypeId: security.id, monthlyAmount: 900_000, issueDate: '2027-01-01', dueDate: '2027-01-31', notify: false };
  const dn = await ctx.adminAgent.post('/api/debit-notes', body);
  await receive(ctx, m.id, 500_000);
  const other = await invoiceFor(m.id, 300_000, { dueDate: '2027-03-01' });

  const v = await ctx.adminAgent.post(`/api/debit-notes/${dn.body.notes[0].noteId}/void`, { reason: 'Wrong security fee' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.status, 'VOID');
  assert.equal((await prisma.invoice.findUnique({ where: { id: other.id } })).status, 'PAID');
  assert.equal((await prisma.user.findUnique({ where: { id: m.id } })).creditBalance, 200_000);
  const st = await memberStatement(m.id);
  const rev = st.rows.filter((x) => x.type === 'Reversal');
  assert.equal(rev.length, 1, 'the whole note is one reversal line');
  assert.equal(rev[0].credit, 12 * 900_000);
  await assertStatementAgrees(m.id);

  const again = await ctx.adminAgent.post('/api/debit-notes', { ...body, monthlyAmount: 100_000 });
  assert.equal(again.body.issued, 1);
  await assertStatementAgrees(m.id);
  await assertLedgerConsistent(assert);
});
