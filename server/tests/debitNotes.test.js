import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createUser, login, outbox, prisma, setup, assertLedgerConsistent } from './helpers.js';
import { plannedLines } from '../src/services/debitNotes.js';

after(() => prisma.$disconnect());

async function fees() {
  const annual = await prisma.feeType.findUnique({ where: { code: 'ANNUAL_DEV_FEE' } });
  const security = await prisma.feeType.create({ data: { code: 'SECURITY_FEE', name: 'Security Fee', amount: 1_000_000, frequency: 'MONTHLY' } });
  return { annual, security };
}

const body = (f, over = {}) => ({
  year: 2027,
  annualFeeTypeId: f.annual.id,
  annualAmount: 2_500_000, // ₦25,000
  monthlyFeeTypeId: f.security.id,
  monthlyAmount: 1_000_000, // ₦10,000 a month
  issueDate: '2027-01-01',
  dueDate: '2027-01-31',
  message: 'Pay to Leadway Estate RA, Zenith Bank 1234567890',
  ...over,
});

test('plannedLines: annual due plus January to December, due up front or month by month', () => {
  const f = { annualFee: { id: 1, name: 'Annual Due' }, monthlyFee: { id: 2, name: 'Security Fee' } };
  const up = plannedLines({ ...f, year: 2027, annualAmount: 100, monthlyAmount: 10, fromMonth: 1, toMonth: 12, dueDate: '2027-01-31', monthlyDue: 'UPFRONT' });
  assert.equal(up.length, 13);
  assert.equal(up[0].description, 'Annual Due – 2027');
  assert.equal(up[1].period, '2027-01');
  assert.equal(up[12].description, 'Security Fee – December 2027');
  assert.ok(up.every((l) => l.dueDate === '2027-01-31'));
  const monthly = plannedLines({ ...f, year: 2027, annualAmount: 100, monthlyAmount: 10, fromMonth: 1, toMonth: 12, dueDate: '2027-01-31', monthlyDue: 'MONTHLY' });
  assert.deepEqual(monthly.slice(1, 4).map((l) => l.dueDate), ['2027-01-31', '2027-02-28', '2027-03-31']);
  const late = plannedLines({ ...f, annualFee: null, year: 2027, monthlyAmount: 10, fromMonth: 7, toMonth: 12, dueDate: '2027-07-10', monthlyDue: 'UPFRONT' });
  assert.equal(late.length, 6);
});

test('issue debit notes: preview, one note per member, payments net off, statement shows the note', async () => {
  const ctx = await setup({ residents: 2 });
  const f = await fees();
  const [a, b] = ctx.residents;
  // B already has the January security fee from the monthly run, and ₦5,000 credit in hand.
  await prisma.invoice.create({ data: { userId: b.id, feeTypeId: f.security.id, period: '2027-01', description: 'Security Fee – January 2027', amount: 1_000_000, dueDate: new Date('2027-01-15T00:00:00Z') } });
  await prisma.user.update({ where: { id: b.id }, data: { creditBalance: 500_000 } });
  await prisma.creditEntry.create({ data: { userId: b.id, amount: 500_000, kind: 'ADJUSTMENT', note: 'advance' } });

  const pv = await ctx.adminAgent.post('/api/debit-notes/preview', body(f));
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.perMember, 2_500_000 + 12 * 1_000_000);
  assert.equal(pv.body.ready.length, 2);
  assert.deepEqual(pv.body.ready.map((r) => [r.newLines, r.existingLines]), [[13, 0], [12, 1]]);
  assert.equal(await prisma.debitNote.count(), 0, 'preview saves nothing');

  const r = await ctx.adminAgent.post('/api/debit-notes', body(f));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.issued, 2);
  assert.deepEqual(r.body.notes.map((n) => n.noteNo), ['DN-2027-0001', 'DN-2027-0002']);
  assert.equal(await prisma.invoice.count({ where: { userId: b.id } }), 13, 'the existing January bill joined the note');
  assert.ok(outbox.email.some((e) => e.subject.includes('DN-2027-0001')));
  assert.ok(await prisma.notification.findFirst({ where: { userId: a.id, title: { startsWith: 'Debit note DN-2027-0001' } } }));

  // B's credit was applied to the note straight away.
  const noteB = await ctx.adminAgent.get(`/api/debit-notes/${r.body.notes[1].noteId}`);
  assert.equal(noteB.body.paid, 500_000);
  assert.equal(noteB.body.status, 'PARTIAL');

  // Issuing again bills nothing twice.
  const again = await ctx.adminAgent.post('/api/debit-notes', body(f));
  assert.equal(again.body.issued, 0);
  assert.equal(again.body.skipped.length, 2);

  // A pays ₦30,000: the annual due (₦25,000) then ₦5,000 of January.
  const pay = await ctx.adminAgent.post('/api/payments/receive', { userId: a.id, amount: 3_000_000, method: 'BANK_TRANSFER', paidAt: '2026-11-05', reference: 'TRF-DN-1' });
  assert.equal(pay.status, 201, JSON.stringify(pay.body));
  const noteA = (await ctx.adminAgent.get(`/api/debit-notes/${r.body.notes[0].noteId}`)).body;
  assert.equal(noteA.amount, 14_500_000);
  assert.equal(noteA.paid, 3_000_000);
  assert.equal(noteA.balance, 11_500_000);
  assert.equal(noteA.invoices[0].status, 'PAID');
  assert.equal(noteA.invoices[1].status, 'PARTIAL');
  assert.equal(noteA.receipts.length, 1);

  // The member sees their own note, and not someone else's.
  const resA = await login(a);
  assert.equal((await resA.get(`/api/debit-notes/${noteA.id}`)).status, 200);
  assert.equal((await resA.get(`/api/debit-notes/${r.body.notes[1].noteId}`)).status, 404);
  const mine = await resA.get('/api/debit-notes');
  assert.deepEqual(mine.body.rows.map((n) => n.noteNo), ['DN-2027-0001']);

  // Statement: the note is one charge line; the payment nets it off.
  const st = (await resA.get('/api/me/statement')).body;
  const dn = st.rows.find((x) => x.type === 'Debit note');
  assert.equal(dn.ref, 'DN-2027-0001');
  assert.equal(dn.debit, 14_500_000);
  assert.match(dn.description, /Security Fee × 12 months/);
  assert.equal(st.closing, 11_500_000);

  // List filters and totals.
  const open = await ctx.adminAgent.get('/api/debit-notes?year=2027&status=OPEN');
  assert.equal(open.body.rows.length, 2);
  assert.equal(open.body.totals.balance, 11_500_000 + (14_500_000 - 500_000));
  const csv = await ctx.adminAgent.get('/api/debit-notes?year=2027&format=csv');
  assert.match(csv.text, /DN-2027-0002/);
  await assertLedgerConsistent(assert);
});

test('cancel a debit note: refused once paid; otherwise its lines are freed so it can be issued again', async () => {
  const ctx = await setup({ residents: 1 });
  const f = await fees();
  const [a] = ctx.residents;
  const r = await ctx.adminAgent.post('/api/debit-notes', body(f, { monthlyAmount: 900_000, notify: false }));
  const noteId = r.body.notes[0].noteId;

  const v = await ctx.adminAgent.post(`/api/debit-notes/${noteId}/void`, { reason: 'Wrong security fee' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.status, 'VOID');
  assert.equal(await prisma.invoice.count({ where: { userId: a.id, status: { not: 'VOID' } } }), 0);

  const again = await ctx.adminAgent.post('/api/debit-notes', body(f, { notify: false }));
  assert.equal(again.body.issued, 1);
  assert.equal(again.body.notes[0].noteNo, 'DN-2027-0002');
  assert.equal(again.body.notes[0].total, 2_500_000 + 12 * 1_000_000);

  await ctx.adminAgent.post('/api/payments/receive', { userId: a.id, amount: 100_000, method: 'CASH', paidAt: '2026-11-05' });
  const refused = await ctx.adminAgent.post(`/api/debit-notes/${again.body.notes[0].noteId}/void`, { reason: 'x' });
  assert.equal(refused.status, 409);

  // Only for chosen members; residents cannot issue.
  const res = await login(a);
  assert.equal((await res.post('/api/debit-notes', body(f))).status, 403);
  const b = await createUser({ firstName: 'New', lastName: 'Joiner' });
  const one = await ctx.adminAgent.post('/api/debit-notes', body(f, { userIds: [b.id], annualFeeTypeId: null, fromMonth: 7, notify: false }));
  assert.equal(one.body.issued, 1);
  assert.equal(one.body.notes[0].total, 6 * 1_000_000);
  await assertLedgerConsistent(assert);
});
