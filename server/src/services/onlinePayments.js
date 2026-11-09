import crypto from 'node:crypto';
import { prisma, transaction, lockMember } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import { invoiceBalance } from '../lib/money.js';
import { paystack } from './paystack.js';
import { memberBalance, recordPayment } from './ledger.js';
import { notifyPayment } from './receipts.js';

export const MIN_ONLINE_AMOUNT = 10_000; // ₦100

/**
 * Start a Paystack payment. The server decides the amount: the chosen invoice's
 * balance, or everything outstanding; a resident may pay part of it (≥ ₦100),
 * never more than is owed.
 */
export async function initializeOnlinePayment(user, { invoiceId, amount }) {
  let max;
  if (invoiceId) {
    const inv = await prisma.invoice.findFirst({ where: { id: invoiceId, userId: user.id } });
    if (!inv) throw notFound('Invoice not found');
    max = invoiceBalance(inv);
    if (!['UNPAID', 'PARTIAL'].includes(inv.status) || max <= 0) throw badRequest('This invoice is already settled');
  } else {
    max = (await memberBalance(user.id)).outstanding;
    if (max <= 0) throw badRequest('You have nothing outstanding to pay');
  }
  const charge = amount ?? max;
  if (charge > max) throw badRequest('You cannot pay more than you owe online');
  if (charge < Math.min(MIN_ONLINE_AMOUNT, max)) throw badRequest('The minimum online payment is ₦100');

  const reference = `LWE-PS-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const op = await prisma.onlinePayment.create({ data: { reference, userId: user.id, invoiceId: invoiceId ?? null, amount: charge } });
  const data = await paystack.initialize({
    email: user.email,
    amount: charge,
    reference,
    callbackUrl: `${config.appUrl}/pay/callback`,
    metadata: { onlinePaymentId: op.id, userId: user.id, invoiceId: invoiceId ?? null, membershipId: user.membershipId },
  });
  await prisma.onlinePayment.update({ where: { id: op.id }, data: { accessCode: data.access_code } });
  return { reference, accessCode: data.access_code, authorizationUrl: data.authorization_url, amount: charge, publicKey: config.paystack.publicKey };
}

/**
 * Confirm a payment (webhook, browser callback, or a Paystack retry). Always
 * re-verifies server-to-server, and applies a reference at most once.
 * Returns { status, paymentId? }.
 */
export async function confirmOnlinePayment(reference) {
  const op = await prisma.onlinePayment.findUnique({ where: { reference } });
  if (!op) return { status: 'unknown' };
  if (op.status === 'SUCCESS') return { status: 'success', paymentId: op.paymentId, alreadyApplied: true };

  const tx = await paystack.verify(reference);
  if (tx.reference !== reference) return { status: 'invalid' };
  if (tx.status !== 'success') {
    if (['failed', 'abandoned', 'reversed'].includes(tx.status)) {
      await prisma.onlinePayment.updateMany({ where: { id: op.id, status: 'PENDING' }, data: { status: 'FAILED', failureNote: tx.gateway_response || tx.status } });
      return { status: 'failed' };
    }
    return { status: 'pending' };
  }
  if (tx.currency !== 'NGN') {
    await prisma.onlinePayment.updateMany({ where: { id: op.id, status: 'PENDING' }, data: { failureNote: `Unexpected currency ${tx.currency}` } });
    return { status: 'invalid' };
  }
  const meta = typeof tx.metadata === 'string' ? safeJson(tx.metadata) : tx.metadata;
  if (meta && meta.onlinePaymentId != null && Number(meta.onlinePaymentId) !== op.id) return { status: 'invalid' };
  const received = Number(tx.amount);
  if (!Number.isInteger(received) || received <= 0) return { status: 'invalid' };

  const result = await transaction(async (db) => {
    await lockMember(db, op.userId);
    const fresh = await db.onlinePayment.findUniqueOrThrow({ where: { id: op.id } });
    if (fresh.status === 'SUCCESS') return { status: 'success', paymentId: fresh.paymentId, alreadyApplied: true };
    // Prefer the invoice the resident chose, if it is still open.
    let invoiceId = null;
    if (op.invoiceId) {
      const inv = await db.invoice.findUnique({ where: { id: op.invoiceId } });
      if (inv && ['UNPAID', 'PARTIAL'].includes(inv.status)) invoiceId = inv.id;
    }
    const note = received !== op.amount ? `Paystack amount ${received} differs from requested ${op.amount}` : null;
    const { payment } = await recordPayment(db, {
      userId: op.userId,
      amount: received,
      method: 'PAYSTACK',
      paidAt: tx.paid_at ? new Date(tx.paid_at) : new Date(),
      reference,
      note,
      invoiceId,
    });
    await db.onlinePayment.update({ where: { id: op.id }, data: { status: 'SUCCESS', paymentId: payment.id, failureNote: note } });
    return { status: 'success', paymentId: payment.id, alreadyApplied: false };
  });
  if (!result.alreadyApplied) await notifyPayment(result.paymentId);
  return result;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
