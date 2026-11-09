import { Router } from 'express';
import { prisma } from '../db.js';
import { notFound } from '../lib/errors.js';
import { parse, z, id, text, isoDate } from '../lib/validate.js';
import { requireAuth, requireResident } from '../middleware/auth.js';
import { memberBalance, paymentInclude } from '../services/ledger.js';
import { memberStatement } from './reports.js';
import { planInclude, withProgress } from '../services/plans.js';

// The signed-in member's own data. Every query is keyed on req.user.id.
export const router = Router();

router.get('/summary', requireResident, async (req, res) => {
  const [balance, recentPayments, unread, openRequests] = await Promise.all([
    memberBalance(req.user.id),
    prisma.payment.findMany({ where: { userId: req.user.id, status: 'COMPLETED' }, orderBy: { paidAt: 'desc' }, take: 5 }),
    prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    prisma.serviceRequest.count({ where: { userId: req.user.id, status: { in: ['OPEN', 'IN_PROGRESS'] } } }),
  ]);
  const plan = await prisma.paymentPlan.findFirst({ where: { userId: req.user.id, status: 'ACTIVE' }, include: planInclude });
  res.json({ balance, recentPayments, unreadNotifications: unread, openRequests, plan: plan ? await withProgress(plan) : null });
});

router.get('/invoices', requireResident, async (req, res) => {
  const rows = await prisma.invoice.findMany({
    where: { userId: req.user.id, status: { not: 'VOID' } },
    orderBy: [{ dueDate: 'desc' }, { id: 'desc' }],
    include: { feeType: { select: { name: true } }, allocations: { where: { payment: { status: 'COMPLETED' } }, include: { payment: { select: { id: true, receiptNo: true, paidAt: true, method: true } } } } },
  });
  res.json({ rows });
});

router.get('/payments', requireResident, async (req, res) => {
  const rows = await prisma.payment.findMany({ where: { userId: req.user.id }, orderBy: { paidAt: 'desc' }, include: paymentInclude });
  res.json({ rows });
});

router.get('/credits', requireResident, async (req, res) => {
  res.json({ rows: await prisma.creditEntry.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } }) });
});

router.get('/statement', requireResident, async (req, res) => {
  const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
  res.json(await memberStatement(req.user.id, q.from, q.to));
});

// Residents may keep their own phone number current; everything else is managed by the office.
router.patch('/profile', requireAuth, async (req, res) => {
  const body = parse(z.object({ phone: z.string().trim().max(30).nullable() }), req.body);
  const user = await prisma.user.update({ where: { id: req.user.id }, data: { phone: body.phone || null }, select: { id: true, phone: true } });
  res.json(user);
});

// ---- Notifications (any signed-in user) -----------------------------------

router.get('/notifications', requireAuth, async (req, res) => {
  const rows = await prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ rows, unread: rows.filter((r) => !r.readAt).length });
});

router.post('/notifications/:id/read', requireAuth, async (req, res) => {
  const nId = parse(id, req.params.id);
  const r = await prisma.notification.updateMany({ where: { id: nId, userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: r.count });
});

router.post('/notifications/read-all', requireAuth, async (req, res) => {
  const r = await prisma.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ updated: r.count });
});

// ---- Service requests (complaints / maintenance) ---------------------------

export const REQUEST_CATEGORIES = ['Security', 'Electricity', 'Water', 'Roads & Drainage', 'Waste', 'Noise / Nuisance', 'Facilities', 'Other'];

router.get('/requests', requireResident, async (req, res) => {
  res.json({ rows: await prisma.serviceRequest.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' } }), categories: REQUEST_CATEGORIES });
});

router.post('/requests', requireResident, async (req, res) => {
  const body = parse(z.object({ category: z.enum(REQUEST_CATEGORIES), title: text(120), description: text(2000) }), req.body);
  const row = await prisma.serviceRequest.create({ data: { ...body, userId: req.user.id } });
  // Let the executives know.
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { id: true } });
  if (admins.length) {
    await prisma.notification.createMany({
      data: admins.map((a) => ({ userId: a.id, title: `New request: ${row.title}`, body: `${req.user.firstName} ${req.user.lastName} (${req.user.membershipId}) – ${row.category}`, link: `/admin/requests?open=${row.id}` })),
    });
  }
  res.status(201).json(row);
});

router.post('/requests/:id/close', requireResident, async (req, res) => {
  const rId = parse(id, req.params.id);
  const r = await prisma.serviceRequest.updateMany({ where: { id: rId, userId: req.user.id, status: { not: 'CLOSED' } }, data: { status: 'CLOSED' } });
  if (!r.count) throw notFound('Request not found');
  res.json({ ok: true });
});
