import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dateOnly, todayIso } from '../lib/dates.js';
import { formatNaira } from '../lib/money.js';
import { sendEmail } from '../lib/messaging.js';
import { id, isoDate, kobo, optionalText, parse, text, z } from '../lib/validate.js';
import { memberBalance } from '../services/ledger.js';
import { planInclude, scheduleFor, withProgress } from '../services/plans.js';

// Admin: payment plans (clearing a debt in monthly instalments).
export const router = Router();

router.get('/', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED', 'ALL']).default('ACTIVE'), userId: id.optional() }), req.query);
  const plans = await prisma.paymentPlan.findMany({
    where: { ...(q.status === 'ALL' ? {} : { status: q.status }), ...(q.userId ? { userId: q.userId } : {}) },
    orderBy: [{ createdAt: 'desc' }],
    include: planInclude,
  });
  const rows = [];
  for (const p of plans) rows.push(await withProgress(p));
  res.json({ rows: q.status === 'ALL' ? rows : rows.filter((r) => r.status === q.status) });
});

const planBody = z.object({
  userId: id,
  totalAmount: kobo.optional(), // default: everything the member owes now
  instalments: z.number().int().min(2, 'must be at least 2').max(24, 'must be at most 24'),
  firstDueDate: isoDate,
  note: optionalText(500),
});

router.post('/preview', async (req, res) => {
  const body = parse(planBody, req.body);
  const balance = await memberBalance(body.userId);
  const total = body.totalAmount ?? balance.outstanding;
  res.json({ outstanding: balance.outstanding, totalAmount: total, schedule: total > 0 ? scheduleFor(total, body.instalments, body.firstDueDate) : [] });
});

router.post('/', async (req, res) => {
  const body = parse(planBody.extend({ notify: z.boolean().default(true) }), req.body);
  const member = await prisma.user.findUnique({ where: { id: body.userId }, select: { role: true, firstName: true, email: true, membershipId: true } });
  if (!member) throw notFound('Member not found');
  if (member.role !== 'RESIDENT') throw badRequest('Payment plans are for residents');
  if (body.firstDueDate < todayIso()) throw badRequest('The first instalment cannot be due in the past');
  const balance = await memberBalance(body.userId);
  const total = body.totalAmount ?? balance.outstanding;
  if (total <= 0) throw badRequest('This member owes nothing, so there is nothing to spread out');
  if (Math.floor(total / body.instalments) < 100) throw badRequest('Each instalment must be at least ₦1');
  if (await prisma.paymentPlan.findFirst({ where: { userId: body.userId, status: 'ACTIVE' } })) throw conflict('This member already has an active payment plan; cancel it first');
  const plan = await prisma.paymentPlan.create({
    data: { userId: body.userId, totalAmount: total, instalments: body.instalments, firstDueDate: dateOnly(body.firstDueDate), startDate: dateOnly(todayIso()), note: body.note, createdById: req.user.id },
    include: planInclude,
  });
  const out = await withProgress(plan);
  await audit(req, 'plan.create', 'PaymentPlan', plan.id, { membershipId: member.membershipId, total, instalments: body.instalments, firstDueDate: body.firstDueDate });
  if (body.notify) {
    const lines = out.schedule.map((s) => `  ${s.number}. ${s.dueDate}: ${formatNaira(s.amount)}`);
    await prisma.notification.create({ data: { userId: body.userId, title: `Payment plan agreed: ${formatNaira(total)} in ${body.instalments} instalments`, body: `First instalment of ${formatNaira(out.schedule[0].amount)} due on ${body.firstDueDate}.`, link: '/' } });
    await sendEmail({
      to: member.email,
      subject: `${config.estateName}: your payment plan`,
      text: [`Dear ${member.firstName},`, '', `Your payment plan for ${formatNaira(total)} has been set up as follows:`, ...lines, '', 'Pay each instalment by its due date (online, by transfer or at the office) and the plan clears itself.', `See your plan any time: ${config.appUrl}/`, '', config.estateName].join('\n'),
    });
  }
  res.status(201).json(out);
});

router.post('/:id/cancel', async (req, res) => {
  const planId = parse(id, req.params.id);
  const body = parse(z.object({ reason: text(300) }), req.body);
  const plan = await prisma.paymentPlan.findUnique({ where: { id: planId } });
  if (!plan) throw notFound('Plan not found');
  if (plan.status !== 'ACTIVE') throw badRequest('Only an active plan can be cancelled');
  const updated = await prisma.paymentPlan.update({ where: { id: planId }, data: { status: 'CANCELLED', cancelReason: body.reason, closedAt: new Date() }, include: planInclude });
  await audit(req, 'plan.cancel', 'PaymentPlan', planId, { reason: body.reason });
  res.json(await withProgress(updated));
});
