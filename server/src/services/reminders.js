import { prisma } from '../db.js';
import { config } from '../config.js';
import { daysBetween, toIso, todayIso, localParts } from '../lib/dates.js';
import { formatNaira } from '../lib/money.js';
import { runLimited, sendEmail, sendSms } from '../lib/messaging.js';
import { activePlansByMember } from './plans.js';
import { getSetting } from './settings.js';

// Reminders to members who owe. A member on a payment plan who is keeping up
// is left alone; one who has fallen behind is reminded of the instalment instead.

const OPEN = ['UNPAID', 'PARTIAL'];

/** Every active resident with bills past their due date, oldest debt first. */
export async function listDebtors() {
  const today = todayIso();
  const overdue = await prisma.invoice.groupBy({
    by: ['userId'],
    where: { status: { in: OPEN }, dueDate: { lt: new Date(`${today}T00:00:00.000Z`) }, user: { role: 'RESIDENT', isActive: true } },
    _sum: { amount: true, amountPaid: true },
    _min: { dueDate: true },
    _count: true,
  });
  if (!overdue.length) return [];
  const ids = overdue.map((o) => o.userId);
  const [users, last, plans, totals] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, membershipId: true, firstName: true, lastName: true, email: true, phone: true, plotNumber: true, street: true, occupancyType: true } }),
    prisma.reminderLog.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _max: { createdAt: true } }),
    activePlansByMember(),
    prisma.invoice.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: { in: OPEN } }, _sum: { amount: true, amountPaid: true } }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const lastSent = new Map(last.map((l) => [l.userId, l._max.createdAt]));
  const total = new Map(totals.map((t) => [t.userId, (t._sum.amount || 0) - (t._sum.amountPaid || 0)]));
  return overdue
    .map((o) => {
      const plan = plans.get(o.userId);
      return {
        ...byId.get(o.userId),
        overdue: (o._sum.amount || 0) - (o._sum.amountPaid || 0),
        outstanding: total.get(o.userId) || 0,
        overdueBills: o._count,
        oldestDueDate: toIso(o._min.dueDate),
        daysOverdue: daysBetween(toIso(o._min.dueDate), today),
        lastReminded: lastSent.get(o.userId) || null,
        plan: plan ? { id: plan.id, behind: plan.behind, nextInstalment: plan.nextInstalment, remaining: plan.remaining } : null,
      };
    })
    .filter((d) => d.overdue > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue || b.overdue - a.overdue);
}

function message(d) {
  const name = config.estateName;
  const payLink = `${config.appUrl}/`;
  if (d.plan) {
    const next = d.plan.nextInstalment;
    return {
      title: `Payment plan: ${formatNaira(d.plan.behind)} is due`,
      body: `Your payment plan is behind by ${formatNaira(d.plan.behind)}. Please pay to keep the plan on track.`,
      email: [
        `Dear ${d.firstName},`,
        '',
        `This is a reminder that your payment plan with ${name} is behind by ${formatNaira(d.plan.behind)}.`,
        next ? `Instalment ${next.number} (${formatNaira(next.amount)}) was due on ${next.dueDate}.` : '',
        `Still to pay on the plan: ${formatNaira(d.plan.remaining)}.`,
        '',
        `Pay online or see your statement: ${payLink}`,
        `Membership ID: ${d.membershipId}`,
        '',
        'If you have already paid, thank you, and please ignore this message.',
        '',
        name,
      ].filter((l) => l !== '').join('\n'),
      sms: `${name}: your payment plan is behind by ${formatNaira(d.plan.behind)}. Please pay at ${payLink} (ID ${d.membershipId}). Ignore if paid.`,
    };
  }
  return {
    title: `Reminder: ${formatNaira(d.overdue)} is overdue`,
    body: `You have ${d.overdueBills} overdue bill(s) totalling ${formatNaira(d.overdue)}, the oldest due on ${d.oldestDueDate}. Please pay to keep your account in good standing.`,
    email: [
      `Dear ${d.firstName},`,
      '',
      `Our records show ${formatNaira(d.overdue)} overdue on your ${name} account (${d.overdueBills} bill(s), the oldest due on ${d.oldestDueDate}).`,
      d.outstanding > d.overdue ? `Your total balance, including bills not yet due, is ${formatNaira(d.outstanding)}.` : '',
      '',
      `Pay online or see your statement: ${payLink}`,
      `Membership ID: ${d.membershipId}`,
      '',
      'If you cannot pay in full, please speak to the estate office about a payment plan.',
      'If you have already paid, thank you, and please ignore this message.',
      '',
      name,
    ].filter((l) => l !== '').join('\n'),
    sms: `${name}: ${formatNaira(d.overdue)} is overdue on your account (ID ${d.membershipId}). Please pay at ${payLink}. Ignore if paid.`,
  };
}

/**
 * Remind `debtors` (rows from listDebtors) by in-app notification, plus email
 * and/or SMS. Returns counts.
 */
export async function sendReminders(debtors, { email, sms, automatic = false }) {
  const result = { reminded: 0, emailSent: 0, emailFailed: 0, smsSent: 0, smsFailed: 0 };
  await runLimited(debtors, 5, async (d) => {
    const m = message(d);
    await prisma.notification.create({ data: { userId: d.id, title: m.title, body: m.body, link: '/statement' } });
    const e = email && d.email ? await sendEmail({ to: d.email, subject: `${config.estateName}: ${m.title}`, text: m.email }) : false;
    const s = sms && d.phone ? await sendSms({ to: d.phone, message: m.sms }) : false;
    if (email && d.email) result[e ? 'emailSent' : 'emailFailed']++;
    if (sms && d.phone) result[s ? 'smsSent' : 'smsFailed']++;
    await prisma.reminderLog.create({ data: { userId: d.id, amount: d.plan ? d.plan.behind : d.overdue, emailSent: e, smsSent: s, automatic } });
    result.reminded++;
  });
  return result;
}

/** Who the weekly automatic run would remind, given the settings. */
export function dueForAutomatic(debtors, s, now = new Date()) {
  const sixDaysAgo = now.getTime() - 6 * 86_400_000;
  return debtors.filter((d) => {
    if (d.plan && d.plan.behind <= 0) return false; // keeping up with a plan
    if ((d.plan ? d.plan.behind : d.overdue) < s.minAmount) return false;
    if (!d.plan && d.daysOverdue < s.minDaysOverdue) return false;
    if (d.lastReminded && new Date(d.lastReminded).getTime() > sixDaysAgo) return false;
    return true;
  });
}

/** Called daily by the scheduler: sends the weekly reminders on the chosen weekday. */
export async function runAutomaticReminders(now = new Date()) {
  const s = await getSetting('reminders');
  if (!s.auto) return null;
  const { year, month, day } = localParts(now);
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== Number(s.weekday)) return null;
  const due = dueForAutomatic(await listDebtors(), s, now);
  const r = await sendReminders(due, { email: s.email, sms: s.sms, automatic: true });
  if (r.reminded) await prisma.auditLog.create({ data: { action: 'reminders.auto', entity: 'Reminder', details: r } });
  return r;
}
