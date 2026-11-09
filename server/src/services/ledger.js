import crypto from 'node:crypto';
import { prisma, transaction, lockMember } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { invoiceBalance, invoiceStatusFor, sum } from '../lib/money.js';
import { todayIso } from '../lib/dates.js';

// The member ledger. Every payment, from any channel (cash, transfer, POS,
// Paystack, account credit), goes through allocatePayment, so there is one
// implementation of "who owes what". All functions that write take the
// transaction client `tx` and lock the member row first.

const OPEN = ['UNPAID', 'PARTIAL'];
const RECEIPT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function newReceiptNo(tx, at = new Date()) {
  const day = todayIso(at).replace(/-/g, '');
  for (let i = 0; i < 10; i++) {
    let suffix = '';
    for (let j = 0; j < 6; j++) suffix += RECEIPT_ALPHABET[crypto.randomInt(RECEIPT_ALPHABET.length)];
    const receiptNo = `LWE-${day}-${suffix}`;
    if (!(await tx.payment.findUnique({ where: { receiptNo }, select: { id: true } }))) return receiptNo;
  }
  throw new Error('Could not allocate a receipt number');
}

async function openInvoices(tx, userId) {
  return tx.invoice.findMany({
    where: { userId, status: { in: OPEN } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Plan how `amount` settles the member's open invoices: the chosen invoice(s)
 * first, in the order given, then oldest due date first; whatever is left is credit.
 */
export function planAllocation(invoices, amount, preferred) {
  const wanted = (Array.isArray(preferred) ? preferred : preferred ? [preferred] : []).map(Number);
  const byId = new Map(invoices.map((inv) => [inv.id, inv]));
  for (const id of wanted) if (!byId.has(id)) throw badRequest('That bill is not open for this member');
  const ordered = [...wanted.map((id) => byId.get(id)), ...invoices.filter((inv) => !wanted.includes(inv.id))];
  let remaining = amount;
  const lines = [];
  for (const inv of ordered) {
    if (remaining <= 0) break;
    const balance = invoiceBalance(inv);
    if (balance <= 0) continue;
    const take = Math.min(balance, remaining);
    lines.push({ invoiceId: inv.id, description: inv.description, dueDate: inv.dueDate, balance, amount: take, settles: take === balance });
    remaining -= take;
  }
  return { lines, credit: remaining };
}

export async function previewAllocation(userId, amount, preferred) {
  const invoices = await openInvoices(prisma, userId);
  return planAllocation(invoices, amount, preferred);
}

/**
 * Credit a payment to the member: allocate, keep any excess as account credit,
 * and issue one receipt. Must run inside `transaction()`.
 */
export async function recordPayment(tx, p) {
  const { userId, amount, method, paidAt = new Date(), reference = null, note = null, recordedById = null, invoiceId = null, invoiceIds = null } = p;
  if (!(await lockMember(tx, userId))) throw notFound('Member not found');
  if (reference) {
    const dup = await tx.payment.findUnique({ where: { reference }, select: { receiptNo: true } });
    if (dup) throw conflict(`Reference ${reference} was already used on receipt ${dup.receiptNo}`);
  }
  const plan = planAllocation(await openInvoices(tx, userId), amount, invoiceIds?.length ? invoiceIds : invoiceId);

  const payment = await tx.payment.create({
    data: {
      receiptNo: await newReceiptNo(tx, paidAt),
      userId,
      amount,
      method,
      paidAt,
      reference,
      note,
      recordedById,
    },
  });
  await applyLines(tx, payment.id, plan.lines);
  if (plan.credit > 0) {
    await tx.creditEntry.create({
      data: { userId, amount: plan.credit, kind: 'OVERPAYMENT', paymentId: payment.id, note: `Excess of receipt ${payment.receiptNo}` },
    });
    await tx.user.update({ where: { id: userId }, data: { creditBalance: { increment: plan.credit } } });
  }
  return { payment, lines: plan.lines, credit: plan.credit };
}

async function applyLines(tx, paymentId, lines) {
  for (const line of lines) {
    // Re-read under the member lock and re-check: the plan must still fit.
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: line.invoiceId } });
    if (!OPEN.includes(inv.status) || invoiceBalance(inv) < line.amount) throw conflict('An invoice changed while the payment was being recorded; please try again');
    const amountPaid = inv.amountPaid + line.amount;
    await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid, status: invoiceStatusFor(inv.amount, amountPaid) } });
    await tx.paymentAllocation.create({ data: { paymentId, invoiceId: inv.id, amount: line.amount } });
  }
}

/**
 * Use the member's account credit against their open invoices (oldest first).
 * Records an ACCOUNT_CREDIT receipt. Must run inside `transaction()`.
 */
export async function applyCredit(tx, userId, recordedById = null) {
  await lockMember(tx, userId);
  const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } });
  if (user.creditBalance <= 0) return null;
  const invoices = await openInvoices(tx, userId);
  const due = sum(invoices.map(invoiceBalance));
  const amount = Math.min(due, user.creditBalance);
  if (amount <= 0) return null;
  const plan = planAllocation(invoices, amount);
  const payment = await tx.payment.create({
    data: {
      receiptNo: await newReceiptNo(tx),
      userId,
      amount,
      method: 'ACCOUNT_CREDIT',
      paidAt: new Date(),
      note: 'Paid from account credit',
      recordedById,
    },
  });
  await applyLines(tx, payment.id, plan.lines);
  await tx.creditEntry.create({ data: { userId, amount: -amount, kind: 'APPLIED', paymentId: payment.id, note: `Applied on receipt ${payment.receiptNo}` } });
  await tx.user.update({ where: { id: userId }, data: { creditBalance: { decrement: amount } } });
  return { payment, lines: plan.lines };
}

/**
 * Reverse a mistaken payment (recorded in error, or the money never arrived):
 * the bills it paid go back to owing, and any credit it created is taken back.
 * If that credit has already been used on other bills, those credit
 * applications are undone first (the bills reopen), then whatever credit is
 * left is used again, oldest bills first.
 */
export async function reversePayment(paymentId, reason, actorId) {
  return transaction(async (tx) => {
    const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { userId: true } });
    if (!head) throw notFound('Payment not found');
    await lockMember(tx, head.userId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { creditEntries: true } });
    if (payment.status === 'REVERSED') throw conflict('This payment is already reversed');
    if (payment.method === 'PAYSTACK') throw badRequest('Online payments cannot be reversed here; refund them from the Paystack dashboard and record the refund as a credit adjustment. You can still move it to other bills.');

    // Credit this payment created that has since been spent: undo the latest credit applications until it is back.
    const creditEffect = sum(payment.creditEntries.map((c) => c.amount));
    const undone = [];
    for (;;) {
      const user = await tx.user.findUniqueOrThrow({ where: { id: payment.userId }, select: { creditBalance: true } });
      if (user.creditBalance - creditEffect >= 0) break;
      const last = await tx.payment.findFirst({
        where: { userId: payment.userId, method: 'ACCOUNT_CREDIT', status: 'COMPLETED', id: { not: payment.id } },
        orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      });
      if (!last) throw conflict('The account credit from this payment has already been paid out to the member (a refund). Add the credit back first (Adjust credit), then reverse.');
      await reverseInTx(tx, last.id, `Undone because ${payment.receiptNo} was reversed`, actorId);
      undone.push(last.receiptNo);
    }
    const reversed = await reverseInTx(tx, payment.id, reason, actorId);
    // Use any credit left over on the member's open bills again.
    if (undone.length) await applyCredit(tx, payment.userId, actorId);
    return { ...reversed, undone };
  });
}

async function reverseInTx(tx, paymentId, reason, actorId) {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { allocations: true, creditEntries: true } });
  for (const a of payment.allocations) {
    if (a.amount <= 0) continue;
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
    const amountPaid = inv.amountPaid - a.amount;
    await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid, status: inv.status === 'VOID' ? 'VOID' : invoiceStatusFor(inv.amount, amountPaid) } });
  }
  // Net credit effect of this payment: +excess for a cash payment, -applied for a credit payment.
  const creditEffect = sum(payment.creditEntries.map((c) => c.amount));
  if (creditEffect !== 0) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: payment.userId }, select: { creditBalance: true } });
    if (user.creditBalance - creditEffect < 0) throw conflict('The account credit from this payment has already been used');
    await tx.creditEntry.create({
      data: { userId: payment.userId, amount: -creditEffect, kind: 'REVERSAL', paymentId: payment.id, note: `Reversal of ${payment.receiptNo}` },
    });
    await tx.user.update({ where: { id: payment.userId }, data: { creditBalance: { decrement: creditEffect } } });
  }
  return tx.payment.update({
    where: { id: payment.id },
    data: { status: 'REVERSED', reversedAt: new Date(), reverseReason: reason, note: payment.note ? `${payment.note} | reversed by #${actorId}` : `Reversed by #${actorId}` },
  });
}

// ---- Corrections: bills raised in error, payments put on the wrong bills ----------

/**
 * Lower a bill to `newAmount` (0 reverses it in full). Money already paid on it
 * beyond the new amount comes off the latest payments first and is kept as the
 * member's credit; the caller then uses that credit on the other open bills.
 * Must run inside `transaction()` with the member locked.
 */
export async function reduceBillTx(tx, invoiceId, newAmount, reason, actorId) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { debitNote: { select: { noteNo: true } } } });
  if (inv.status === 'VOID') throw conflict('This bill is already reversed');
  if (newAmount >= inv.amount) throw badRequest('The new amount must be less than the bill');
  let excess = inv.amountPaid - newAmount;
  let released = 0;
  if (excess > 0) {
    const allocations = await tx.paymentAllocation.findMany({
      where: { invoiceId, amount: { gt: 0 }, payment: { status: 'COMPLETED' } },
      include: { payment: { select: { id: true, receiptNo: true, paidAt: true } } },
      orderBy: [{ payment: { paidAt: 'desc' } }, { id: 'desc' }],
    });
    for (const a of allocations) {
      if (excess <= 0) break;
      const take = Math.min(a.amount, excess);
      if (take === a.amount) await tx.paymentAllocation.delete({ where: { id: a.id } });
      else await tx.paymentAllocation.update({ where: { id: a.id }, data: { amount: a.amount - take } });
      await tx.creditEntry.create({
        data: { userId: inv.userId, amount: take, kind: 'OVERPAYMENT', paymentId: a.payment.id, note: `From ${a.payment.receiptNo}: ${inv.description} ${newAmount === 0 ? 'reversed' : 'reduced'} (${reason})` },
      });
      await tx.user.update({ where: { id: inv.userId }, data: { creditBalance: { increment: take } } });
      excess -= take;
      released += take;
    }
  }
  const amountPaid = inv.amountPaid - released;
  const full = newAmount === 0;
  await tx.invoice.update({
    where: { id: inv.id },
    data: full
      ? // A reversed debit-note line frees its month, so the note can be issued again.
        { status: 'VOID', amountPaid, voidReason: `Reversed: ${reason}`, ...(inv.debitNoteId ? { period: null } : {}) }
      : { amount: newAmount, amountPaid, status: invoiceStatusFor(newAmount, amountPaid) },
  });
  await tx.billAdjustment.create({
    data: { invoiceId: inv.id, userId: inv.userId, kind: full ? 'REVERSE' : 'REDUCE', amount: inv.amount - newAmount, reason, createdById: actorId },
  });
  return { invoiceId: inv.id, description: inv.description, from: inv.amount, to: newAmount, released };
}

/** Reverse (newAmount 0) or lower one bill, then use any freed money on the other open bills. */
export async function reduceBill(invoiceId, newAmount, reason, actorId) {
  return transaction(async (tx) => {
    const head = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { userId: true } });
    if (!head) throw notFound('Bill not found');
    await lockMember(tx, head.userId);
    const r = await reduceBillTx(tx, invoiceId, newAmount, reason, actorId);
    const applied = r.released ? await applyCredit(tx, head.userId, actorId) : null;
    return { ...r, reapplied: applied ? applied.lines : [] };
  });
}

async function paymentForMove(tx, paymentId) {
  const payment = await tx.payment.findUnique({ where: { id: paymentId }, include: { allocations: { where: { amount: { gt: 0 } } } } });
  if (!payment) throw notFound('Payment not found');
  if (payment.status !== 'COMPLETED') throw conflict('A reversed payment cannot be moved');
  return payment;
}

/**
 * Point a payment at different bills (e.g. it settled 2026 bills but was meant
 * for the 2027 debit note). What the payment covered is put back on its bills,
 * then the same money settles `invoiceIds` first, in that order, and anything
 * left settles the oldest bills as usual (or stays as credit).
 */
export async function movePayment(paymentId, invoiceIds, actorId, { dryRun = false } = {}) {
  const run = async (tx) => {
    const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { userId: true } });
    if (!head) throw notFound('Payment not found');
    await lockMember(tx, head.userId);
    const payment = await paymentForMove(tx, paymentId);
    const moving = sum(payment.allocations.map((a) => a.amount));
    if (moving <= 0) throw badRequest('This payment is not on any bill (it is held as account credit). Credit is used on new bills automatically.');
    const before = await describe(tx, payment.allocations);
    // Undo this payment's allocations (in memory for a preview).
    const open = await tx.invoice.findMany({
      where: { userId: payment.userId, OR: [{ status: { in: OPEN } }, { id: { in: payment.allocations.map((a) => a.invoiceId) }, status: { not: 'VOID' } }] },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
    const freed = new Map();
    for (const a of payment.allocations) freed.set(a.invoiceId, (freed.get(a.invoiceId) || 0) + a.amount);
    const reopened = open.map((inv) => {
      const amountPaid = inv.amountPaid - (freed.get(inv.id) || 0);
      return { ...inv, amountPaid, status: inv.status === 'VOID' ? 'VOID' : invoiceStatusFor(inv.amount, amountPaid) };
    }).filter((inv) => OPEN.includes(inv.status));
    const plan = planAllocation(reopened, moving, invoiceIds);
    if (!plan.lines.length || !invoiceIds.some((id) => plan.lines.some((l) => l.invoiceId === Number(id)))) throw badRequest('Choose at least one bill that still has something to pay');
    const result = { payment: { id: payment.id, receiptNo: payment.receiptNo, amount: payment.amount }, moving, before, after: plan.lines, credit: plan.credit };
    if (dryRun) return result;

    for (const a of payment.allocations) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
      const amountPaid = inv.amountPaid - a.amount;
      await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid, status: inv.status === 'VOID' ? 'VOID' : invoiceStatusFor(inv.amount, amountPaid) } });
      await tx.paymentAllocation.delete({ where: { id: a.id } });
    }
    await applyLines(tx, payment.id, plan.lines);
    if (plan.credit > 0) {
      await tx.creditEntry.create({ data: { userId: payment.userId, amount: plan.credit, kind: 'OVERPAYMENT', paymentId: payment.id, note: `Left over when ${payment.receiptNo} was moved to other bills` } });
      await tx.user.update({ where: { id: payment.userId }, data: { creditBalance: { increment: plan.credit } } });
    }
    return result;
  };
  if (!dryRun) return transaction(run);
  // A preview runs the same checks in a transaction that is always rolled back.
  let preview;
  await transaction(async (tx) => {
    preview = await run(tx);
    throw ROLLBACK;
  }).catch((err) => {
    if (err !== ROLLBACK) throw err;
  });
  return preview;
}

const ROLLBACK = new Error('rollback');

async function describe(tx, allocations) {
  const invs = await tx.invoice.findMany({ where: { id: { in: allocations.map((a) => a.invoiceId) } }, select: { id: true, description: true } });
  const name = new Map(invs.map((i) => [i.id, i.description]));
  return allocations.map((a) => ({ invoiceId: a.invoiceId, description: name.get(a.invoiceId), amount: a.amount }));
}

/** Manual credit adjustment by an executive (e.g. a refund or goodwill credit). */
export async function adjustCredit(userId, amount, note) {
  return transaction(async (tx) => {
    if (!(await lockMember(tx, userId))) throw notFound('Member not found');
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } });
    if (user.creditBalance + amount < 0) throw badRequest('That would make the credit balance negative');
    await tx.creditEntry.create({ data: { userId, amount, kind: 'ADJUSTMENT', note } });
    await tx.user.update({ where: { id: userId }, data: { creditBalance: { increment: amount } } });
    if (amount > 0) await applyCredit(tx, userId);
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: { creditBalance: true } });
  });
}

/** Totals for one member: billed, paid, outstanding, overdue, credit. */
export async function memberBalance(userId, client = prisma) {
  const today = new Date(`${todayIso()}T00:00:00.000Z`);
  const [billed, open, overdue, user] = await Promise.all([
    client.invoice.aggregate({ where: { userId, status: { not: 'VOID' } }, _sum: { amount: true, amountPaid: true } }),
    client.invoice.aggregate({ where: { userId, status: { in: OPEN } }, _sum: { amount: true, amountPaid: true }, _count: true }),
    client.invoice.aggregate({ where: { userId, status: { in: OPEN }, dueDate: { lt: today } }, _sum: { amount: true, amountPaid: true }, _count: true }),
    client.user.findUnique({ where: { id: userId }, select: { creditBalance: true } }),
  ]);
  const cashPaid = await client.payment.aggregate({ where: { userId, status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' } }, _sum: { amount: true } });
  return {
    billed: billed._sum.amount || 0,
    settled: billed._sum.amountPaid || 0,
    paid: cashPaid._sum.amount || 0,
    outstanding: (open._sum.amount || 0) - (open._sum.amountPaid || 0),
    openInvoices: open._count,
    overdue: (overdue._sum.amount || 0) - (overdue._sum.amountPaid || 0),
    overdueInvoices: overdue._count,
    credit: user?.creditBalance || 0,
  };
}

/** Outstanding balance per member, for lists. */
export async function outstandingByMember(userIds) {
  const rows = await prisma.invoice.groupBy({
    by: ['userId'],
    where: { status: { in: OPEN }, ...(userIds ? { userId: { in: userIds } } : {}) },
    _sum: { amount: true, amountPaid: true },
  });
  return new Map(rows.map((r) => [r.userId, (r._sum.amount || 0) - (r._sum.amountPaid || 0)]));
}

export const paymentInclude = {
  user: { select: { id: true, membershipId: true, firstName: true, lastName: true, email: true, phone: true, plotNumber: true, street: true } },
  recordedBy: { select: { firstName: true, lastName: true } },
  allocations: { include: { invoice: { select: { id: true, description: true, period: true, amount: true, amountPaid: true, status: true } } } },
  creditEntries: true,
};
