import { Router } from 'express';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { dateOnly, todayIso } from '../lib/dates.js';
import { parse, paging, pageQuery, z, id, kobo, text, optionalText, isoDate } from '../lib/validate.js';
import { sendEmail } from '../lib/messaging.js';
import { config } from '../config.js';
import { removeSampleData, sampleDataSummary } from '../services/sampleData.js';

// Admin: dashboard, service requests, expenses, audit log.
export const router = Router();

// ---- Dashboard -------------------------------------------------------------

router.get('/dashboard', async (_req, res) => {
  const today = todayIso();
  const monthStart = dateOnly(`${today.slice(0, 7)}-01`);
  const todayDate = dateOnly(today);
  const notCredit = { status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' } };
  const [residents, owners, inactive, billedMonth, collectedMonth, open, overdue, expensesMonth, lowStock, openRequests, onsite, recentPayments, collectedYear] =
    await Promise.all([
      prisma.user.count({ where: { role: 'RESIDENT', isActive: true } }),
      prisma.user.count({ where: { role: 'RESIDENT', isActive: true, occupancyType: 'OWNER' } }),
      prisma.user.count({ where: { role: 'RESIDENT', isActive: false } }),
      prisma.invoice.aggregate({ where: { status: { not: 'VOID' }, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.payment.aggregate({ where: { ...notCredit, paidAt: { gte: monthStart } }, _sum: { amount: true }, _count: true }),
      prisma.invoice.aggregate({ where: { status: { in: ['UNPAID', 'PARTIAL'] } }, _sum: { amount: true, amountPaid: true }, _count: true }),
      prisma.invoice.aggregate({ where: { status: { in: ['UNPAID', 'PARTIAL'] }, dueDate: { lt: todayDate } }, _sum: { amount: true, amountPaid: true }, _count: true }),
      prisma.expense.aggregate({ where: { date: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.$queryRaw`SELECT count(*)::int AS n FROM "Asset" WHERE "isActive" AND "category" = 'CONSUMABLE' AND "quantity" <= "minQuantity"`,
      prisma.serviceRequest.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
      prisma.visitorPass.count({ where: { status: 'CHECKED_IN' } }),
      prisma.payment.findMany({
        where: { status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { user: { select: { firstName: true, lastName: true, membershipId: true } } },
      }),
      prisma.payment.aggregate({ where: { ...notCredit, paidAt: { gte: dateOnly(`${today.slice(0, 4)}-01-01`) } }, _sum: { amount: true } }),
    ]);
  const creditHeld = await prisma.user.aggregate({ where: { role: 'RESIDENT' }, _sum: { creditBalance: true } });
  const debtors = await prisma.invoice.groupBy({ by: ['userId'], where: { status: { in: ['UNPAID', 'PARTIAL'] }, dueDate: { lt: todayDate } } });
  res.json({
    residents: { active: residents, owners, tenants: residents - owners, inactive },
    month: {
      billed: billedMonth._sum.amount || 0,
      collected: collectedMonth._sum.amount || 0,
      payments: collectedMonth._count,
      expenses: expensesMonth._sum.amount || 0,
    },
    yearCollected: collectedYear._sum.amount || 0,
    outstanding: { amount: (open._sum.amount || 0) - (open._sum.amountPaid || 0), invoices: open._count },
    overdue: { amount: (overdue._sum.amount || 0) - (overdue._sum.amountPaid || 0), invoices: overdue._count, members: debtors.length },
    creditHeld: creditHeld._sum.creditBalance || 0,
    lowStock: lowStock[0]?.n || 0,
    openRequests,
    visitorsOnSite: onsite,
    recentPayments,
  });
});

// ---- Service requests ------------------------------------------------------

router.get('/requests', async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ACTIVE']).optional() }), req.query);
  const where = q.status === 'ACTIVE' ? { status: { in: ['OPEN', 'IN_PROGRESS'] } } : q.status ? { status: q.status } : {};
  const [total, rows] = await Promise.all([
    prisma.serviceRequest.count({ where }),
    prisma.serviceRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      include: { user: { select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, street: true, phone: true } } },
      ...paging(q),
    }),
  ]);
  res.json({ total, rows });
});

router.patch('/requests/:id', async (req, res) => {
  const rId = parse(id, req.params.id);
  const body = parse(z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']), adminNote: optionalText(2000) }), req.body);
  const before = await prisma.serviceRequest.findUnique({ where: { id: rId }, include: { user: true } });
  if (!before) throw notFound('Request not found');
  const row = await prisma.serviceRequest.update({
    where: { id: rId },
    data: { status: body.status, adminNote: body.adminNote ?? before.adminNote, resolvedAt: body.status === 'RESOLVED' ? new Date() : before.resolvedAt },
  });
  if (before.status !== body.status || (body.adminNote && body.adminNote !== before.adminNote)) {
    const label = body.status.replace('_', ' ').toLowerCase();
    await prisma.notification.create({
      data: { userId: before.userId, title: `Your request "${before.title}" is ${label}`, body: body.adminNote || 'The estate office has updated your request.', link: '/requests' },
    });
    if (body.status === 'RESOLVED') {
      await sendEmail({
        to: before.user.email,
        subject: `${config.estateName}: request resolved – ${before.title}`,
        text: `Dear ${before.user.firstName},\n\nYour request "${before.title}" has been marked resolved.\n${body.adminNote ? `\nNote from the office: ${body.adminNote}\n` : ''}\n${config.estateName}`,
      });
    }
  }
  await audit(req, 'request.update', 'ServiceRequest', rId, { from: before.status, to: body.status });
  res.json(row);
});

// ---- Expenses (association spending) ---------------------------------------

export const EXPENSE_CATEGORIES = ['Security', 'Electricity / Diesel', 'Water', 'Waste Disposal', 'Repairs & Maintenance', 'Roads & Drainage', 'Salaries & Wages', 'Administration', 'Bank Charges', 'Events', 'Other'];

const expenseBody = z.object({
  date: isoDate,
  category: z.enum(EXPENSE_CATEGORIES),
  description: text(300),
  payee: optionalText(120),
  amount: kobo,
  reference: optionalText(100),
});

router.get('/expenses', async (req, res) => {
  const q = parse(pageQuery.extend({ from: isoDate.optional(), to: isoDate.optional(), category: z.string().max(60).optional() }), req.query);
  const where = { ...(q.category ? { category: q.category } : {}) };
  if (q.from || q.to) where.date = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) };
  const [total, rows, sums] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({ where, orderBy: [{ date: 'desc' }, { id: 'desc' }], include: { recordedBy: { select: { firstName: true, lastName: true } } }, ...paging(q) }),
    prisma.expense.aggregate({ where, _sum: { amount: true } }),
  ]);
  res.json({ total, rows, totals: { amount: sums._sum.amount || 0 }, categories: EXPENSE_CATEGORIES });
});

router.post('/expenses', async (req, res) => {
  const body = parse(expenseBody, req.body);
  const row = await prisma.expense.create({ data: { ...body, date: dateOnly(body.date), recordedById: req.user.id } });
  await audit(req, 'expense.create', 'Expense', row.id, body);
  res.status(201).json(row);
});

router.patch('/expenses/:id', async (req, res) => {
  const eId = parse(id, req.params.id);
  const body = parse(expenseBody.partial(), req.body);
  const before = await prisma.expense.findUnique({ where: { id: eId } });
  if (!before) throw notFound('Expense not found');
  const row = await prisma.expense.update({ where: { id: eId }, data: { ...body, ...(body.date ? { date: dateOnly(body.date) } : {}) } });
  await audit(req, 'expense.update', 'Expense', eId, { before: { amount: before.amount, date: before.date, category: before.category }, after: body });
  res.json(row);
});

router.delete('/expenses/:id', async (req, res) => {
  const eId = parse(id, req.params.id);
  const before = await prisma.expense.findUnique({ where: { id: eId } });
  if (!before) throw notFound('Expense not found');
  await prisma.expense.delete({ where: { id: eId } });
  await audit(req, 'expense.delete', 'Expense', eId, before);
  res.json({ ok: true });
});

// ---- Sample data -------------------------------------------------------------

router.get('/sample-data', async (_req, res) => {
  res.json({ loaded: await sampleDataSummary() });
});

router.post('/sample-data/remove', async (req, res) => {
  const removed = await removeSampleData();
  if (!removed) throw notFound('No sample data is loaded');
  await audit(req, 'sampleData.remove', 'SampleData', null, removed);
  res.json({ removed });
});

// ---- Audit log ---------------------------------------------------------------

router.get('/audit', async (req, res) => {
  const q = parse(pageQuery.extend({ entity: z.string().max(40).optional(), action: z.string().max(60).optional() }), req.query);
  const where = { ...(q.entity ? { entity: q.entity } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, include: { actor: { select: { firstName: true, lastName: true, membershipId: true } } }, ...paging(q) }),
  ]);
  res.json({ total, rows });
});
