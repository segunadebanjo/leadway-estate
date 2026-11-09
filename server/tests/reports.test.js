import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { assertLedgerConsistent, invoiceFor, login, prisma, setup } from './helpers.js';
import { bucketFor } from '../src/routes/reports.js';
import { toCsv } from '../src/lib/csv.js';
import { todayIso, addDays } from '../src/lib/dates.js';

// One realistic month of activity, then every report must agree with the
// dashboard and with each member's own balance.
let ctx;
let a;
let b;
let c;
const today = todayIso();
before(async () => {
  ctx = await setup({ residents: 3 });
  [a, b, c] = ctx.residents;
  await invoiceFor(a.id, 500_000, { dueDate: addDays(today, -100), description: 'Old due' });
  await invoiceFor(a.id, 500_000, { dueDate: addDays(today, -45), description: 'Mid due' });
  await invoiceFor(b.id, 4_000_000, { dueDate: addDays(today, -10), description: 'Dev fee' });
  await invoiceFor(c.id, 500_000, { dueDate: addDays(today, 5), description: 'Not due' });
  const receive = (body) => ctx.adminAgent.post('/api/payments/receive', { paidAt: today, method: 'CASH', ...body });
  await receive({ userId: a.id, amount: 700_000 });
  await receive({ userId: b.id, amount: 1_000_000, method: 'BANK_TRANSFER', reference: '=HYPERLINK("x")' });
  await receive({ userId: c.id, amount: 800_000, method: 'POS' }); // ₦3,000 excess → credit
  const rev = await receive({ userId: b.id, amount: 50_000 });
  await ctx.adminAgent.post(`/api/payments/${rev.body.payment.id}/reverse`, { reason: 'Entered twice' });
  await ctx.adminAgent.post('/api/admin/expenses', { date: today, category: 'Security', description: 'Guards', amount: 900_000 });
});
after(() => prisma.$disconnect());

test('ledger invariants hold', async () => {
  await assertLedgerConsistent(assert);
});

test('collections = cash actually received (no credit moves, no reversed payments) and match the dashboard', async () => {
  const col = (await ctx.adminAgent.get(`/api/reports/collections?from=${today}&to=${today}`)).body;
  assert.equal(col.total, 700_000 + 1_000_000 + 800_000);
  assert.equal(col.count, 3);
  assert.equal(col.byFee.reduce((s, x) => s + x.amount, 0), col.total, 'by-fee breakdown adds up, including advance credit');
  assert.equal(col.byMethod.reduce((s, x) => s + x.amount, 0), col.total);
  const dash = (await ctx.adminAgent.get('/api/admin/dashboard')).body;
  assert.equal(dash.month.collected, col.total);
});

test('outstanding & ageing agrees with member balances and the dashboard', async () => {
  const out = (await ctx.adminAgent.get('/api/reports/outstanding')).body;
  const ra = out.rows.find((r) => r.userId === a.id);
  assert.equal(ra.d90plus, 0, 'the oldest bill was paid first');
  assert.equal(ra.d31_60, 300_000);
  assert.equal(out.rows.find((r) => r.userId === b.id).d1_30, 3_000_000);
  assert.equal(out.rows.find((r) => r.userId === c.id), undefined, 'c is fully paid');
  let sumBalances = 0;
  for (const m of [a, b, c]) sumBalances += (await ctx.adminAgent.get(`/api/residents/${m.id}`)).body.balance.outstanding;
  assert.equal(out.totals.total, sumBalances);
  const dash = (await ctx.adminAgent.get('/api/admin/dashboard')).body;
  assert.equal(dash.outstanding.amount, out.totals.total);
  assert.equal(dash.creditHeld, 300_000);
});

test('ageing buckets', () => {
  assert.deepEqual([0, 1, 30, 31, 60, 61, 90, 91, -3].map(bucketFor), ['notDue', 'd1_30', 'd1_30', 'd31_60', 'd31_60', 'd61_90', 'd61_90', 'd90plus', 'notDue']);
});

test('member statement closing balance = outstanding − credit, for admin and the member', async () => {
  for (const m of [a, b, c]) {
    const st = (await ctx.adminAgent.get(`/api/reports/statement?userId=${m.id}`)).body;
    const bal = (await ctx.adminAgent.get(`/api/residents/${m.id}`)).body.balance;
    assert.equal(st.closing, bal.outstanding - bal.credit, `member ${m.id}`);
  }
  const own = (await (await login(c)).get('/api/me/statement')).body;
  assert.equal(own.closing, -300_000, 'in credit');
});

test('income & expenditure', async () => {
  const ie = (await ctx.adminAgent.get(`/api/reports/income-expenditure?from=${today}&to=${today}`)).body;
  assert.equal(ie.totalIncome, 2_500_000);
  assert.equal(ie.totalExpenditure, 900_000);
  assert.equal(ie.surplus, 1_600_000);
});

test('billing vs collection covers the year', async () => {
  const r = (await ctx.adminAgent.get('/api/reports/billing-vs-collection')).body;
  assert.equal(r.rows.length, 12);
  assert.equal(r.totals.collected, 2_500_000);
});

test('CSV downloads are formula-injection safe', async () => {
  const res = await ctx.adminAgent.get(`/api/reports/collections?from=${today}&to=${today}&format=csv`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.match(res.text, /"'=HYPERLINK\(""x""\)"/);
  assert.ok(!/,=HYPERLINK/.test(res.text));
  assert.equal(toCsv([{ key: 'v', label: 'V' }], [{ v: '+1' }, { v: '-2' }, { v: '@x' }, { v: 'ok' }]).trim().split('\r\n').slice(1).join('|'), "'+1|'-2|'@x|ok");
  for (const r of ['outstanding', 'members', 'assets', 'billing-vs-collection', `statement?userId=${a.id}&`, `income-expenditure?from=${today}&`]) {
    const url = `/api/reports/${r}${r.includes('?') ? '' : '?'}format=csv`;
    const x = await ctx.adminAgent.get(url);
    assert.equal(x.status, 200, url);
  }
});

test('the resident portal shows the same figures', async () => {
  const me = await login(a);
  const s = (await me.get('/api/me/summary')).body;
  const bal = (await ctx.adminAgent.get(`/api/residents/${a.id}`)).body.balance;
  assert.deepEqual(s.balance, bal);
  assert.equal(s.balance.paid, 700_000);
  assert.ok(s.balance.overdue > 0);
  const inv = (await me.get('/api/me/invoices')).body.rows;
  assert.ok(inv.every((i) => i.userId === a.id));
});
