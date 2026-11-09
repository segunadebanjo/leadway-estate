import { prisma } from '../db.js';
import { dateOnly, toIso, todayIso } from '../lib/dates.js';

// Payment plans: a member agrees to clear a debt in equal monthly instalments.
// The bills themselves are untouched (payments still settle the oldest bill
// first); the plan is measured against the cash the member pays from the day
// it was agreed, so nothing on the ledger can disagree with it.

/** Same day `months` later, kept inside the month (31 Jan + 1 → 28/29 Feb). */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Equal instalments in kobo; the last one takes the remainder. */
export function scheduleFor(totalAmount, instalments, firstDueIso) {
  const base = Math.floor(totalAmount / instalments);
  return Array.from({ length: instalments }, (_, i) => ({
    number: i + 1,
    dueDate: addMonths(firstDueIso, i),
    amount: i === instalments - 1 ? totalAmount - base * (instalments - 1) : base,
  }));
}

/** Pure: a plan's schedule with each instalment's state, given the cash paid towards it. */
export function progressOf(plan, paid, today = todayIso()) {
  const first = toIso(plan.firstDueDate);
  let cum = 0;
  let dueToDate = 0;
  const schedule = scheduleFor(plan.totalAmount, plan.instalments, first).map((s) => {
    const before = cum;
    cum += s.amount;
    if (s.dueDate <= today) dueToDate += s.amount;
    const state = paid >= cum ? 'PAID' : paid > before ? 'PART_PAID' : s.dueDate < today ? 'OVERDUE' : 'UPCOMING';
    return { ...s, paidSoFar: Math.max(0, Math.min(s.amount, paid - before)), state };
  });
  const next = schedule.find((s) => s.state !== 'PAID') || null;
  return {
    paid: Math.min(paid, plan.totalAmount),
    remaining: Math.max(0, plan.totalAmount - paid),
    behind: Math.max(0, dueToDate - paid),
    nextInstalment: next,
    schedule,
  };
}

async function cashPaidSince(userId, startDate) {
  const r = await prisma.payment.aggregate({
    where: { userId, status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' }, paidAt: { gte: startDate } },
    _sum: { amount: true },
  });
  return r._sum.amount || 0;
}

/** A plan with its progress; an active plan that has been paid in full is marked completed. */
export async function withProgress(plan) {
  const paid = await cashPaidSince(plan.userId, plan.startDate);
  const progress = progressOf(plan, paid);
  if (plan.status === 'ACTIVE' && progress.remaining === 0) {
    plan = await prisma.paymentPlan.update({ where: { id: plan.id }, data: { status: 'COMPLETED', closedAt: new Date() }, include: planInclude });
  }
  return { ...plan, ...progress };
}

export const planInclude = { user: { select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, street: true, phone: true, email: true } } };

/** userId → { behind, nextInstalment } for members with an active plan. */
export async function activePlansByMember() {
  const plans = await prisma.paymentPlan.findMany({ where: { status: 'ACTIVE' }, include: planInclude });
  const out = new Map();
  for (const p of plans) out.set(p.userId, await withProgress(p));
  return out;
}

export function planStartToday() {
  return dateOnly(todayIso());
}
