import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { notFound } from '../lib/errors.js';
import { dateOnly, daysBetween, localParts, monthName, todayIso, toIso } from '../lib/dates.js';
import { naira, sendCsv } from '../lib/csv.js';
import { parse, z, id, isoDate } from '../lib/validate.js';

// Reports. Every report is JSON for the screen, or CSV for Excel with ?format=csv.
// "Collections" always means cash actually received: account-credit receipts
// are internal moves and reversed payments are excluded.
export const router = Router();

const OPEN = ['UNPAID', 'PARTIAL'];
const CASH = { status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' } };
const METHOD = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', POS: 'POS', PAYSTACK: 'Online (Paystack)' };
const name = (u) => `${u.firstName} ${u.lastName}`;

function range(q) {
  const today = todayIso();
  const from = q.from || `${today.slice(0, 4)}-01-01`;
  const to = q.to || today;
  // Payments are timestamps: [from 00:00 Lagos, to+1 00:00 Lagos).
  return { from, to, gte: new Date(`${from}T00:00:00+01:00`), lt: new Date(new Date(`${to}T00:00:00+01:00`).getTime() + 86_400_000) };
}
const rangeQuery = z.object({ from: isoDate.optional(), to: isoDate.optional(), format: z.enum(['json', 'csv']).default('json') });

// ---- Collections -------------------------------------------------------------

router.get('/collections', async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const r = range(q);
  const payments = await prisma.payment.findMany({
    where: { ...CASH, paidAt: { gte: r.gte, lt: r.lt } },
    orderBy: { paidAt: 'asc' },
    include: {
      user: { select: { membershipId: true, firstName: true, lastName: true, plotNumber: true } },
      allocations: { include: { invoice: { select: { feeType: { select: { name: true } } } } } },
      creditEntries: { where: { kind: 'OVERPAYMENT' } },
      recordedBy: { select: { firstName: true, lastName: true } },
    },
  });
  const byMethod = {};
  const byFee = {};
  const byMonth = {};
  let total = 0;
  for (const p of payments) {
    total += p.amount;
    byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
    const { year, month } = localParts(p.paidAt);
    const key = `${year}-${String(month).padStart(2, '0')}`;
    byMonth[key] = (byMonth[key] || 0) + p.amount;
    for (const a of p.allocations) byFee[a.invoice.feeType.name] = (byFee[a.invoice.feeType.name] || 0) + a.amount;
    const advance = p.creditEntries.reduce((s, c) => s + c.amount, 0);
    if (advance) byFee['Advance payments (account credit)'] = (byFee['Advance payments (account credit)'] || 0) + advance;
  }
  const rows = payments.map((p) => ({
    date: todayIso(p.paidAt),
    receiptNo: p.receiptNo,
    membershipId: p.user.membershipId,
    member: name(p.user),
    plot: p.user.plotNumber,
    method: METHOD[p.method] || p.method,
    reference: p.reference,
    amount: p.amount,
    recordedBy: p.recordedBy ? name(p.recordedBy) : p.method === 'PAYSTACK' ? 'Online' : '',
  }));
  if (q.format === 'csv') {
    return sendCsv(res, `collections_${r.from}_${r.to}.csv`, [
      { key: 'date', label: 'Date' },
      { key: 'receiptNo', label: 'Receipt No' },
      { key: 'membershipId', label: 'Membership ID' },
      { key: 'member', label: 'Member' },
      { key: 'plot', label: 'Plot' },
      { key: 'method', label: 'Method' },
      { key: 'reference', label: 'Reference' },
      { key: 'amount', label: 'Amount (NGN)', map: (x) => naira(x.amount) },
      { key: 'recordedBy', label: 'Recorded by' },
    ], rows);
  }
  const toList = (o, label = (k) => k) => Object.entries(o).map(([k, amount]) => ({ label: label(k), amount })).sort((a, b) => b.amount - a.amount);
  res.json({
    from: r.from,
    to: r.to,
    total,
    count: payments.length,
    byMethod: toList(byMethod, (k) => METHOD[k] || k),
    byFee: toList(byFee),
    byMonth: Object.entries(byMonth).sort().map(([k, amount]) => ({ label: `${monthName(Number(k.slice(5)))} ${k.slice(0, 4)}`, month: k, amount })),
    rows,
  });
});

// ---- Outstanding & ageing ----------------------------------------------------

export const BUCKETS = [
  { key: 'notDue', label: 'Not yet due' },
  { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' },
  { key: 'd61_90', label: '61–90 days' },
  { key: 'd90plus', label: '90+ days' },
];

export function bucketFor(daysOverdue) {
  if (daysOverdue <= 0) return 'notDue';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90plus';
}

router.get('/outstanding', async (req, res) => {
  const q = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
  const today = todayIso();
  const invoices = await prisma.invoice.findMany({
    where: { status: { in: OPEN } },
    include: { user: { select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, phone: true, email: true, isActive: true, creditBalance: true, occupancyType: true } } },
  });
  const members = new Map();
  const totals = Object.fromEntries([...BUCKETS.map((b) => [b.key, 0]), ['total', 0]]);
  for (const inv of invoices) {
    const balance = inv.amount - inv.amountPaid;
    const bucket = bucketFor(daysBetween(toIso(inv.dueDate), today));
    let m = members.get(inv.userId);
    if (!m) {
      const u = inv.user;
      m = { userId: u.id, membershipId: u.membershipId, member: name(u), plot: u.plotNumber, phone: u.phone, email: u.email, occupancy: u.occupancyType, active: u.isActive, credit: u.creditBalance, invoices: 0, oldestDue: toIso(inv.dueDate), total: 0, ...Object.fromEntries(BUCKETS.map((b) => [b.key, 0])) };
      members.set(inv.userId, m);
    }
    m[bucket] += balance;
    m.total += balance;
    m.invoices++;
    if (toIso(inv.dueDate) < m.oldestDue) m.oldestDue = toIso(inv.dueDate);
    totals[bucket] += balance;
    totals.total += balance;
  }
  const rows = [...members.values()].sort((a, b) => b.total - a.total);
  if (q.format === 'csv') {
    return sendCsv(res, `outstanding_ageing_${today}.csv`, [
      { key: 'membershipId', label: 'Membership ID' },
      { key: 'member', label: 'Member' },
      { key: 'plot', label: 'Plot' },
      { key: 'phone', label: 'Phone' },
      { key: 'occupancy', label: 'Occupancy' },
      { key: 'invoices', label: 'Open invoices' },
      { key: 'oldestDue', label: 'Oldest due date' },
      ...BUCKETS.map((b) => ({ key: b.key, label: `${b.label} (NGN)`, map: (x) => naira(x[b.key]) })),
      { key: 'total', label: 'Total outstanding (NGN)', map: (x) => naira(x.total) },
      { key: 'credit', label: 'Credit held (NGN)', map: (x) => naira(x.credit) },
    ], rows);
  }
  res.json({ asOf: today, buckets: BUCKETS, totals, rows });
});

// ---- Billing vs collection, by month -------------------------------------------

router.get('/billing-vs-collection', async (req, res) => {
  const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const year = q.year || Number(todayIso().slice(0, 4));
  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({ where: { status: { not: 'VOID' }, dueDate: { gte: dateOnly(`${year}-01-01`), lte: dateOnly(`${year}-12-31`) } }, select: { amount: true, amountPaid: true, dueDate: true } }),
    prisma.payment.findMany({ where: { ...CASH, paidAt: { gte: new Date(`${year}-01-01T00:00:00+01:00`), lt: new Date(`${year + 1}-01-01T00:00:00+01:00`) } }, select: { amount: true, paidAt: true } }),
  ]);
  const rows = Array.from({ length: 12 }, (_, i) => ({ month: `${year}-${String(i + 1).padStart(2, '0')}`, label: monthName(i + 1), billed: 0, settled: 0, collected: 0 }));
  for (const inv of invoices) {
    const m = rows[Number(toIso(inv.dueDate).slice(5, 7)) - 1];
    m.billed += inv.amount;
    m.settled += inv.amountPaid;
  }
  for (const p of payments) rows[localParts(p.paidAt).month - 1].collected += p.amount;
  for (const r of rows) r.rate = r.billed ? Math.round((r.settled / r.billed) * 1000) / 10 : null;
  const totals = rows.reduce((t, r) => ({ billed: t.billed + r.billed, settled: t.settled + r.settled, collected: t.collected + r.collected }), { billed: 0, settled: 0, collected: 0 });
  totals.rate = totals.billed ? Math.round((totals.settled / totals.billed) * 1000) / 10 : null;
  if (q.format === 'csv') {
    return sendCsv(res, `billing_vs_collection_${year}.csv`, [
      { key: 'label', label: 'Month' },
      { key: 'billed', label: 'Billed (NGN)', map: (x) => naira(x.billed) },
      { key: 'settled', label: 'Of which settled (NGN)', map: (x) => naira(x.settled) },
      { key: 'rate', label: 'Settled %' },
      { key: 'collected', label: 'Cash collected in month (NGN)', map: (x) => naira(x.collected) },
    ], rows);
  }
  res.json({ year, rows, totals });
});

// ---- Member statement (running balance) ---------------------------------------

export async function memberStatement(userId, from, to) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, street: true, email: true, phone: true, creditBalance: true } });
  if (!user) throw notFound('Member not found');
  const [invoices, payments, adjustments, billAdjustments] = await Promise.all([
    // Reversed bills stay on the statement (charge, then a reversal credit) once they have an adjustment record.
    prisma.invoice.findMany({
      where: { userId, OR: [{ status: { not: 'VOID' } }, { adjustments: { some: {} } }] },
      select: { id: true, description: true, amount: true, createdAt: true, dueDate: true, adjustments: { select: { kind: true, amount: true } }, debitNote: { select: { id: true, noteNo: true, year: true, issueDate: true } } },
    }).then((rows) => rows.map((i) => ({ ...i, amount: i.amount + i.adjustments.filter((a) => a.kind === 'REDUCE').reduce((t, a) => t + a.amount, 0) }))),
    prisma.payment.findMany({ where: { userId, ...CASH }, select: { id: true, receiptNo: true, amount: true, paidAt: true, method: true, reference: true } }),
    prisma.creditEntry.findMany({ where: { userId, kind: 'ADJUSTMENT' } }),
    prisma.billAdjustment.findMany({ where: { userId }, include: { invoice: { select: { description: true, createdAt: true, debitNote: { select: { id: true, noteNo: true, issueDate: true } } } } }, orderBy: { id: 'asc' } }),
  ]);
  // Debits: bills. Credits: money received and executive credit adjustments.
  // Closing balance = outstanding − credit held (negative means in credit).
  const entries = [
    ...invoices.filter((i) => !i.debitNote).map((i) => ({ date: todayIso(i.createdAt), sort: i.createdAt.getTime(), type: 'Bill', description: i.description, ref: `INV-${i.id}`, debit: i.amount, credit: 0 })),
    ...debitNoteEntries(invoices.filter((i) => i.debitNote)),
    ...reversalEntries(billAdjustments),
    ...payments.map((p) => ({ date: todayIso(p.paidAt), sort: p.paidAt.getTime(), type: 'Payment', description: `${METHOD[p.method] || p.method}${p.reference ? ` (${p.reference})` : ''}`, ref: p.receiptNo, debit: 0, credit: p.amount, paymentId: p.id })),
    ...adjustments.map((c) => ({ date: todayIso(c.createdAt), sort: c.createdAt.getTime(), type: 'Adjustment', description: c.note || 'Credit adjustment', ref: `ADJ-${c.id}`, debit: c.amount < 0 ? -c.amount : 0, credit: c.amount > 0 ? c.amount : 0 })),
  ].sort((a, b) => a.sort - b.sort);
  let opening = 0;
  let balance = 0;
  const rows = [];
  for (const e of entries) {
    balance += e.debit - e.credit;
    if (from && e.date < from) {
      opening = balance;
      continue;
    }
    if (to && e.date > to) continue;
    const { sort, ...rest } = e;
    rows.push({ ...rest, balance });
  }
  const closing = rows.length ? rows[rows.length - 1].balance : opening;
  return { user, from: from || null, to: to || null, opening, closing, rows, totals: { debit: rows.reduce((s, r) => s + r.debit, 0), credit: rows.reduce((s, r) => s + r.credit, 0) } };
}

// Bills reversed or lowered: a credit line each (a whole debit note reversed at once is one line).
function reversalEntries(adjustments) {
  const groups = new Map();
  for (const a of adjustments) {
    const dn = a.invoice.debitNote;
    const key = dn && a.kind === 'REVERSE' ? `dn${dn.id}|${a.reason}|${todayIso(a.createdAt)}` : `a${a.id}`;
    const g = groups.get(key) || { first: a, amount: 0, count: 0 };
    g.amount += a.amount;
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()].map(({ first: a, amount, count }) => {
    const dn = a.invoice.debitNote;
    const what = count > 1 && dn ? `Debit note ${dn.noteNo}` : a.invoice.description;
    const reason = a.reason.replace(/^Debit note \S+ reversed: /, '');
    // A correction never comes before the charge it corrects (a note can be dated ahead, e.g. 1 January).
    const charged = dn ? dn.issueDate : a.invoice.createdAt;
    const at = a.createdAt > charged ? a.createdAt : charged;
    return {
      date: dn && at === charged ? dn.issueDate.toISOString().slice(0, 10) : todayIso(at),
      sort: at.getTime() + 1,
      type: a.kind === 'REVERSE' ? 'Reversal' : 'Reduction',
      description: `${what} ${a.kind === 'REVERSE' ? 'reversed' : 'reduced'}: ${reason}`,
      ref: count > 1 && dn ? `${dn.noteNo}-R` : `ADJ-${a.id}`,
      debit: 0,
      credit: amount,
      ...(dn ? { debitNoteId: dn.id } : {}),
    };
  });
}

// A debit note is one line on the statement: its number, what it covers and its total.
function debitNoteEntries(lines) {
  const notes = new Map();
  for (const i of [...lines].sort((a, b) => a.id - b.id)) {
    const n = notes.get(i.debitNote.id) || { note: i.debitNote, amount: 0, items: [] };
    n.amount += i.amount;
    n.items.push(i.description.replace(/ – .*$/, ''));
    notes.set(i.debitNote.id, n);
  }
  return [...notes.values()].map(({ note, amount, items }) => {
    const kinds = [...new Set(items)].map((k) => (items.filter((x) => x === k).length > 1 ? `${k} × ${items.filter((x) => x === k).length} months` : k));
    return { date: toIso(note.issueDate), sort: note.issueDate.getTime(), type: 'Debit note', description: `${note.year}: ${kinds.join(', ')}`, ref: note.noteNo, debit: amount, credit: 0, debitNoteId: note.id };
  });
}

router.get('/statement', async (req, res) => {
  const q = parse(z.object({ userId: id, from: isoDate.optional(), to: isoDate.optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const st = await memberStatement(q.userId, q.from, q.to);
  if (q.format === 'csv') {
    const rows = [{ date: q.from || '', type: '', description: 'Opening balance', ref: '', debit: 0, credit: 0, balance: st.opening }, ...st.rows];
    return sendCsv(res, `statement_${st.user.membershipId}.csv`, [
      { key: 'date', label: 'Date' },
      { key: 'type', label: 'Type' },
      { key: 'description', label: 'Description' },
      { key: 'ref', label: 'Reference' },
      { key: 'debit', label: 'Debit (NGN)', map: (x) => (x.debit ? naira(x.debit) : '') },
      { key: 'credit', label: 'Payments & credits (NGN)', map: (x) => (x.credit ? naira(x.credit) : '') },
      { key: 'balance', label: 'Balance (NGN)', map: (x) => naira(x.balance) },
    ], rows);
  }
  res.json(st);
});

// ---- Income & expenditure -------------------------------------------------------

router.get('/income-expenditure', async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const r = range(q);
  const [allocations, advances, expenses] = await Promise.all([
    prisma.paymentAllocation.findMany({
      where: { payment: { ...CASH, paidAt: { gte: r.gte, lt: r.lt } } },
      select: { amount: true, invoice: { select: { feeType: { select: { name: true } } } } },
    }),
    prisma.creditEntry.aggregate({ where: { kind: 'OVERPAYMENT', payment: { ...CASH, paidAt: { gte: r.gte, lt: r.lt } } }, _sum: { amount: true } }),
    prisma.expense.groupBy({ by: ['category'], where: { date: { gte: dateOnly(r.from), lte: dateOnly(r.to) } }, _sum: { amount: true } }),
  ]);
  const income = {};
  for (const a of allocations) income[a.invoice.feeType.name] = (income[a.invoice.feeType.name] || 0) + a.amount;
  if (advances._sum.amount) income['Advance payments (account credit)'] = advances._sum.amount;
  const incomeRows = Object.entries(income).map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
  const expenseRows = expenses.map((e) => ({ label: e.category, amount: e._sum.amount || 0 })).sort((a, b) => b.amount - a.amount);
  const totalIncome = incomeRows.reduce((s, x) => s + x.amount, 0);
  const totalExpenditure = expenseRows.reduce((s, x) => s + x.amount, 0);
  if (q.format === 'csv') {
    const rows = [
      ...incomeRows.map((x) => ({ section: 'Income', ...x })),
      { section: 'Income', label: 'Total income', amount: totalIncome },
      ...expenseRows.map((x) => ({ section: 'Expenditure', ...x })),
      { section: 'Expenditure', label: 'Total expenditure', amount: totalExpenditure },
      { section: 'Result', label: totalIncome >= totalExpenditure ? 'Surplus' : 'Deficit', amount: totalIncome - totalExpenditure },
    ];
    return sendCsv(res, `income_expenditure_${r.from}_${r.to}.csv`, [
      { key: 'section', label: 'Section' },
      { key: 'label', label: 'Item' },
      { key: 'amount', label: 'Amount (NGN)', map: (x) => naira(x.amount) },
    ], rows);
  }
  res.json({ from: r.from, to: r.to, income: incomeRows, expenditure: expenseRows, totalIncome, totalExpenditure, surplus: totalIncome - totalExpenditure });
});

// ---- Registers ---------------------------------------------------------------------

router.get('/assets', async (req, res) => {
  const q = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
  const assets = await prisma.asset.findMany({ where: { isActive: true }, orderBy: [{ category: 'asc' }, { name: 'asc' }], include: { maintenance: { select: { cost: true, date: true } } } });
  const rows = assets.map((a) => ({
    name: a.name,
    category: a.category === 'EQUIPMENT' ? 'Equipment' : 'Consumable',
    quantity: a.quantity,
    unit: a.unit,
    minQuantity: a.minQuantity,
    lowStock: a.category === 'CONSUMABLE' && a.quantity <= a.minQuantity,
    location: a.location,
    serialNumber: a.serialNumber,
    purchaseDate: toIso(a.purchaseDate),
    purchaseCost: a.purchaseCost,
    maintenanceCost: a.maintenance.reduce((s, m) => s + m.cost, 0),
    lastMaintenance: a.maintenance.length ? toIso(a.maintenance.map((m) => m.date).sort((x, y) => y - x)[0]) : null,
  }));
  if (q.format === 'csv') {
    return sendCsv(res, `assets_register_${todayIso()}.csv`, [
      { key: 'name', label: 'Item' },
      { key: 'category', label: 'Category' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'unit', label: 'Unit' },
      { key: 'minQuantity', label: 'Re-order level' },
      { key: 'lowStock', label: 'Low stock', map: (x) => (x.lowStock ? 'YES' : '') },
      { key: 'location', label: 'Location' },
      { key: 'serialNumber', label: 'Serial No' },
      { key: 'purchaseDate', label: 'Purchased' },
      { key: 'purchaseCost', label: 'Cost (NGN)', map: (x) => (x.purchaseCost == null ? '' : naira(x.purchaseCost)) },
      { key: 'maintenanceCost', label: 'Maintenance to date (NGN)', map: (x) => naira(x.maintenanceCost) },
      { key: 'lastMaintenance', label: 'Last maintenance' },
    ], rows);
  }
  res.json({ rows });
});

router.get('/members', async (req, res) => {
  const q = parse(z.object({ format: z.enum(['json', 'csv']).default('json'), status: z.enum(['active', 'all']).default('all') }), req.query);
  const users = await prisma.user.findMany({
    where: { role: 'RESIDENT', ...(q.status === 'active' ? { isActive: true } : {}) },
    orderBy: { membershipId: 'asc' },
    select: { id: true, membershipId: true, firstName: true, lastName: true, email: true, phone: true, plotNumber: true, street: true, occupancyType: true, moveInDate: true, isActive: true, creditBalance: true },
  });
  const owing = await prisma.invoice.groupBy({ by: ['userId'], where: { status: { in: OPEN } }, _sum: { amount: true, amountPaid: true } });
  const owed = new Map(owing.map((o) => [o.userId, (o._sum.amount || 0) - (o._sum.amountPaid || 0)]));
  const rows = users.map((u) => ({ ...u, name: name(u), moveInDate: toIso(u.moveInDate), outstanding: owed.get(u.id) || 0 }));
  if (q.format === 'csv') {
    return sendCsv(res, `member_register_${todayIso()}.csv`, [
      { key: 'membershipId', label: 'Membership ID' },
      { key: 'name', label: 'Name' },
      { key: 'occupancyType', label: 'Occupancy' },
      { key: 'plotNumber', label: 'Plot' },
      { key: 'street', label: 'Street' },
      { key: 'phone', label: 'Phone' },
      { key: 'email', label: 'Email' },
      { key: 'moveInDate', label: 'Moved in' },
      { key: 'isActive', label: 'Status', map: (x) => (x.isActive ? 'Active' : 'Inactive') },
      { key: 'outstanding', label: 'Outstanding (NGN)', map: (x) => naira(x.outstanding) },
      { key: 'creditBalance', label: 'Credit (NGN)', map: (x) => naira(x.creditBalance) },
    ], rows);
  }
  res.json({ rows, estate: config.estateName });
});
