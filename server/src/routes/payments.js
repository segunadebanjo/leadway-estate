import { Router } from 'express';
import { prisma, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { dateOnly, todayIso } from '../lib/dates.js';
import { parse, paging, pageQuery, z, id, kobo, text, optionalText, isoDate } from '../lib/validate.js';
import { requireAdmin, requireResident, requireAuth } from '../middleware/auth.js';
import { paymentInclude, previewAllocation, recordPayment, reversePayment } from '../services/ledger.js';
import { notifyPayment } from '../services/receipts.js';
import { confirmOnlinePayment, initializeOnlinePayment } from '../services/onlinePayments.js';
import { validSignature } from '../services/paystack.js';
import { memberSearch } from './residents.js';

export const router = Router();

// ---- Paystack webhook (public; authenticated by HMAC signature) -------------

router.post('/webhook', async (req, res) => {
  if (!validSignature(req.rawBody, req.get('x-paystack-signature'))) return res.status(401).json({ error: 'Bad signature' });
  const event = req.body;
  if (event?.event === 'charge.success' && event.data?.reference) {
    try {
      await confirmOnlinePayment(String(event.data.reference));
    } catch (err) {
      // A 5xx makes Paystack retry later, which is safe: a reference applies once.
      console.error(`[webhook] ${event.data.reference}: ${err.message}`);
      return res.status(500).json({ error: 'Could not process' });
    }
  }
  res.json({ ok: true });
});

// ---- Resident: pay online --------------------------------------------------

router.post('/initialize', requireResident, async (req, res) => {
  const body = parse(z.object({ invoiceId: id.optional().nullable(), amount: kobo.optional() }), req.body ?? {});
  res.json(await initializeOnlinePayment(req.user, body));
});

// Browser fallback after the popup closes (and the only path on localhost).
router.get('/verify/:reference', requireResident, async (req, res) => {
  const reference = parse(z.string().min(5).max(100), req.params.reference);
  const op = await prisma.onlinePayment.findUnique({ where: { reference } });
  if (!op || op.userId !== req.user.id) throw notFound('Payment not found');
  res.json(await confirmOnlinePayment(reference));
});

// ---- Receipts (admin, or the member the receipt belongs to) -----------------

router.get('/:id', requireAuth, async (req, res) => {
  const paymentId = parse(id, req.params.id);
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: paymentInclude });
  if (!payment) throw notFound('Receipt not found');
  if (req.user.role !== 'ADMIN' && payment.userId !== req.user.id) throw notFound('Receipt not found');
  res.json(payment);
});

// ---- Admin -----------------------------------------------------------------

const listQuery = pageQuery.extend({
  q: z.string().max(100).optional(),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'POS', 'PAYSTACK', 'ACCOUNT_CREDIT']).optional(),
  status: z.enum(['COMPLETED', 'REVERSED']).optional(),
  userId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

router.get('/', requireAdmin, async (req, res) => {
  const q = parse(listQuery, req.query);
  const where = {
    ...(q.method ? { method: q.method } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.q ? { OR: [{ receiptNo: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }, { user: memberSearch(q.q) }] } : {}),
  };
  if (q.from || q.to) where.paidAt = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) };
  const [total, rows, sums] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], include: paymentInclude, ...paging(q) }),
    prisma.payment.aggregate({ where: { ...where, status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' } }, _sum: { amount: true } }),
  ]);
  res.json({ total, page: q.page, pageSize: q.pageSize, rows, totals: { received: sums._sum.amount || 0 } });
});

const receiveBody = z.object({
  userId: id,
  amount: kobo,
  invoiceId: id.optional().nullable(),
});

router.post('/preview', requireAdmin, async (req, res) => {
  const body = parse(receiveBody, req.body);
  res.json(await previewAllocation(body.userId, body.amount, body.invoiceId ?? null));
});

// Receive Payment: credited to the member, allocated oldest-first (or to the
// chosen invoice first); any excess is kept as account credit.
router.post('/receive', requireAdmin, async (req, res) => {
  const body = parse(
    receiveBody.extend({
      method: z.enum(['CASH', 'BANK_TRANSFER', 'POS']),
      paidAt: isoDate,
      reference: optionalText(100),
      note: optionalText(500),
    }),
    req.body,
  );
  if (body.paidAt > todayIso()) throw badRequest('The payment date cannot be in the future');
  const member = await prisma.user.findUnique({ where: { id: body.userId }, select: { role: true } });
  if (!member) throw notFound('Member not found');
  if (member.role !== 'RESIDENT') throw badRequest('Payments can only be received from residents');
  const result = await transaction(async (tx) => {
    const r = await recordPayment(tx, {
      userId: body.userId,
      amount: body.amount,
      method: body.method,
      paidAt: new Date(`${body.paidAt}T12:00:00.000Z`),
      reference: body.reference,
      note: body.note,
      recordedById: req.user.id,
      invoiceId: body.invoiceId ?? null,
    });
    await audit(req, 'payment.receive', 'Payment', r.payment.id, { receiptNo: r.payment.receiptNo, amount: body.amount, method: body.method, credit: r.credit }, tx);
    return r;
  });
  await notifyPayment(result.payment.id);
  res.status(201).json({ payment: await prisma.payment.findUnique({ where: { id: result.payment.id }, include: paymentInclude }), credit: result.credit });
});

router.post('/:id/reverse', requireAdmin, async (req, res) => {
  const paymentId = parse(id, req.params.id);
  const body = parse(z.object({ reason: text(300) }), req.body);
  const payment = await reversePayment(paymentId, body.reason, req.user.id);
  await audit(req, 'payment.reverse', 'Payment', paymentId, { receiptNo: payment.receiptNo, amount: payment.amount, reason: body.reason });
  res.json(payment);
});
