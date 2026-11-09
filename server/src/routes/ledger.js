import { Router } from 'express';
import { prisma, isUniqueViolation } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dateOnly, todayIso } from '../lib/dates.js';
import { parse, paging, pageQuery, z, id, kobo, text, optionalText, isoDate } from '../lib/validate.js';
import { createInvoice, runBilling } from '../services/billing.js';
import { memberSearch } from './residents.js';

// Admin: fee types, invoices, billing.
export const router = Router();

// ---- Fee types -------------------------------------------------------------

router.get('/fee-types', async (_req, res) => {
  res.json({ rows: await prisma.feeType.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] }) });
});

const feeTypeBody = z.object({
  name: text(100),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/, 'use letters, digits and _').optional(),
  amount: kobo,
  frequency: z.enum(['MONTHLY', 'ANNUAL', 'ONE_OFF']),
  description: optionalText(300),
  isActive: z.boolean().default(true),
});

router.post('/fee-types', async (req, res) => {
  const body = parse(feeTypeBody, req.body);
  const code = body.code || body.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  try {
    const row = await prisma.feeType.create({ data: { ...body, code } });
    await audit(req, 'fee_type.create', 'FeeType', row.id, body);
    res.status(201).json(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('A fee type with that code already exists');
    throw err;
  }
});

router.patch('/fee-types/:id', async (req, res) => {
  const ftId = parse(id, req.params.id);
  const body = parse(feeTypeBody.omit({ code: true, frequency: true }).partial(), req.body);
  const before = await prisma.feeType.findUnique({ where: { id: ftId } });
  if (!before) throw notFound('Fee type not found');
  const row = await prisma.feeType.update({ where: { id: ftId }, data: body });
  await audit(req, 'fee_type.update', 'FeeType', ftId, { before: { amount: before.amount, name: before.name, isActive: before.isActive }, after: body });
  res.json(row);
});

// ---- Invoices --------------------------------------------------------------

const invoiceQuery = pageQuery.extend({
  q: z.string().max(100).optional(),
  status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'VOID', 'OPEN']).optional(),
  feeTypeId: id.optional(),
  userId: id.optional(),
  overdue: z.enum(['true', 'false']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

router.get('/invoices', async (req, res) => {
  const q = parse(invoiceQuery, req.query);
  const where = {
    ...(q.status === 'OPEN' ? { status: { in: ['UNPAID', 'PARTIAL'] } } : q.status ? { status: q.status } : {}),
    ...(q.feeTypeId ? { feeTypeId: q.feeTypeId } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.q ? { user: memberSearch(q.q) } : {}),
  };
  if (q.from || q.to) where.dueDate = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) };
  if (q.overdue === 'true') {
    where.status = { in: ['UNPAID', 'PARTIAL'] };
    where.dueDate = { ...(where.dueDate || {}), lt: dateOnly(todayIso()) };
  }
  const [total, rows, sums] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
      include: { user: { select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true } }, feeType: { select: { name: true } } },
      ...paging(q),
    }),
    prisma.invoice.aggregate({ where, _sum: { amount: true, amountPaid: true } }),
  ]);
  res.json({ total, page: q.page, pageSize: q.pageSize, rows, totals: { amount: sums._sum.amount || 0, paid: sums._sum.amountPaid || 0 } });
});

// Assign a fee (e.g. Electricity Connection Fee) to chosen residents.
router.post('/invoices/assign', async (req, res) => {
  const body = parse(
    z
      .object({
        feeTypeId: id,
        userIds: z.array(id).max(5000).optional(),
        allActive: z.boolean().default(false),
        amount: kobo.optional(),
        description: optionalText(200),
        dueDate: isoDate,
        // Optional label (e.g. "2026-Q4"); with it, re-assigning the same fee to the same member is refused.
        period: optionalText(20),
      })
      .refine((b) => b.allActive || (b.userIds && b.userIds.length), { message: 'choose at least one resident', path: ['userIds'] }),
    req.body,
  );
  const feeType = await prisma.feeType.findUnique({ where: { id: body.feeTypeId } });
  if (!feeType || !feeType.isActive) throw badRequest('Choose an active fee type');
  const members = await prisma.user.findMany({
    where: { role: 'RESIDENT', isActive: true, ...(body.allActive ? {} : { id: { in: body.userIds } }) },
    select: { id: true },
  });
  if (!members.length) throw badRequest('None of the chosen members is an active resident');
  const dueDate = dateOnly(body.dueDate);
  let created = 0;
  let duplicates = 0;
  for (const m of members) {
    const inv = await createInvoice({
      userId: m.id,
      feeType,
      period: body.period,
      description: body.description || feeType.name,
      amount: body.amount ?? feeType.amount,
      dueDate,
    });
    if (inv) created++;
    else duplicates++;
  }
  await audit(req, 'invoice.assign', 'FeeType', feeType.id, { members: members.length, created, duplicates, amount: body.amount ?? feeType.amount, period: body.period });
  res.status(201).json({ created, duplicates });
});

router.post('/invoices/:id/void', async (req, res) => {
  const invId = parse(id, req.params.id);
  const body = parse(z.object({ reason: text(300) }), req.body);
  // Only an invoice with nothing paid against it can be voided; the condition is in the UPDATE itself.
  const r = await prisma.invoice.updateMany({ where: { id: invId, amountPaid: 0, status: 'UNPAID' }, data: { status: 'VOID', voidReason: body.reason } });
  if (r.count !== 1) {
    const inv = await prisma.invoice.findUnique({ where: { id: invId } });
    if (!inv) throw notFound('Invoice not found');
    throw conflict('Only an unpaid invoice with nothing paid against it can be voided. Reverse its payments first.');
  }
  await audit(req, 'invoice.void', 'Invoice', invId, body);
  res.json(await prisma.invoice.findUnique({ where: { id: invId } }));
});

// ---- Billing ---------------------------------------------------------------

router.post('/billing/run', async (req, res) => {
  const result = await runBilling();
  await audit(req, 'billing.run', 'Billing', null, result);
  res.json(result);
});
