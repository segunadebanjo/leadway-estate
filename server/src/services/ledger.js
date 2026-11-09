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
 * Plan how `amount` settles the member's open invoices: the chosen invoice
 * first (if any), then oldest due date first; whatever is left is credit.
 */
export function planAllocation(invoices, amount, preferredInvoiceId) {
  const ordered = [...invoices];
  if (preferredInvoiceId) {
    const i = ordered.findIndex((inv) => inv.id === preferredInvoiceId);
    if (i < 0) throw badRequest('That invoice is not open for this member');
    ordered.unshift(...ordered.splice(i, 1));
  }
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

export async function previewAllocation(userId, amount, preferredInvoiceId) {
  const invoices = await openInvoices(prisma, userId);
  return planAllocation(invoices, amount, preferredInvoiceId);
}

/**
 * Credit a payment to the member: allocate, keep any excess as account credit,
 * and issue one receipt. Must run inside `transaction()`.
 */
export async function recordPayment(tx, p) {
  const { userId, amount, method, paidAt = new Date(), reference = null, note = null, recordedById = null, invoiceId = null } = p;
  if (!(await lockMember(tx, userId))) throw notFound('Member not found');
  if (reference) {
    const dup = await tx.payment.findUnique({ where: { reference }, select: { receiptNo: true } });
    if (dup) throw conflict(`Reference ${reference} was already used on receipt ${dup.receiptNo}`);
  }
  const plan = planAllocation(await openInvoices(tx, userId), amount, invoiceId);

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
 * Reverse a mistaken payment: invoices go back to owing what they owed, and
 * any credit the payment created is taken back (refused if it has been spent).
 */
export async function reversePayment(paymentId, reason, actorId) {
  return transaction(async (tx) => {
    const head = await tx.payment.findUnique({ where: { id: paymentId }, select: { userId: true } });
    if (!head) throw notFound('Payment not found');
    await lockMember(tx, head.userId);
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { allocations: true, creditEntries: true } });
    if (payment.status === 'REVERSED') throw conflict('This payment is already reversed');
    if (payment.method === 'PAYSTACK') throw badRequest('Online payments cannot be reversed here; refund them from the Paystack dashboard and record the refund as an adjustment');

    for (const a of payment.allocations) {
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: a.invoiceId } });
      const amountPaid = inv.amountPaid - a.amount;
      await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid, status: invoiceStatusFor(inv.amount, amountPaid) } });
    }
    // Net credit effect of this payment: +excess for a cash payment, -applied for a credit payment.
    const creditEffect = sum(payment.creditEntries.map((c) => c.amount));
    if (creditEffect !== 0) {
      const user = await tx.user.findUniqueOrThrow({ where: { id: payment.userId }, select: { creditBalance: true } });
      if (user.creditBalance - creditEffect < 0) {
        throw conflict('The account credit from this payment has already been used on other bills. Reverse the account-credit receipts that used it first.');
      }
      await tx.creditEntry.create({
        data: { userId: payment.userId, amount: -creditEffect, kind: 'REVERSAL', paymentId: payment.id, note: `Reversal of ${payment.receiptNo}` },
      });
      await tx.user.update({ where: { id: payment.userId }, data: { creditBalance: { decrement: creditEffect } } });
    }
    return tx.payment.update({
      where: { id: payment.id },
      data: { status: 'REVERSED', reversedAt: new Date(), reverseReason: reason, note: payment.note ? `${payment.note} | reversed by #${actorId}` : `Reversed by #${actorId}` },
    });
  });
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
