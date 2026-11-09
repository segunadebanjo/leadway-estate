import { prisma } from '../db.js';
import { config } from '../config.js';
import { escapeHtml, sendEmail } from '../lib/messaging.js';
import { formatNaira } from '../lib/money.js';
import { paymentInclude } from './ledger.js';

const METHOD_LABEL = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', POS: 'POS', PAYSTACK: 'Online (Paystack)', ACCOUNT_CREDIT: 'Account credit' };
export const methodLabel = (m) => METHOD_LABEL[m] || m;

/** In-app notification + emailed e-receipt. Runs after the payment has committed; never throws. */
export async function notifyPayment(paymentId) {
  try {
    const p = await prisma.payment.findUnique({ where: { id: paymentId }, include: paymentInclude });
    if (!p) return;
    const credit = p.creditEntries.filter((c) => c.kind === 'OVERPAYMENT').reduce((a, c) => a + c.amount, 0);
    const lines = p.allocations.map((a) => `  ${a.invoice.description}: ${formatNaira(a.amount)}`);
    if (credit > 0) lines.push(`  Kept as account credit: ${formatNaira(credit)}`);

    await prisma.notification.create({
      data: {
        userId: p.userId,
        title: `Payment received – ${formatNaira(p.amount)}`,
        body: `Receipt ${p.receiptNo}. Thank you.`,
        link: `/receipts/${p.id}`,
      },
    });

    const text = [
      `Dear ${p.user.firstName},`,
      '',
      `We have received your payment of ${formatNaira(p.amount)} (${methodLabel(p.method)}).`,
      '',
      `Receipt number: ${p.receiptNo}`,
      `Membership ID: ${p.user.membershipId}`,
      `Date: ${p.paidAt.toISOString().slice(0, 10)}`,
      '',
      'Applied to:',
      ...lines,
      '',
      `View or print your receipt: ${config.appUrl}/receipts/${p.id}`,
      '',
      `${config.estateName} Residents' Association`,
    ].join('\n');
    const rows = p.allocations
      .map((a) => `<tr><td style="padding:4px 8px">${escapeHtml(a.invoice.description)}</td><td style="padding:4px 8px;text-align:right">${formatNaira(a.amount)}</td></tr>`)
      .join('');
    const creditRow = credit > 0 ? `<tr><td style="padding:4px 8px">Kept as account credit</td><td style="padding:4px 8px;text-align:right">${formatNaira(credit)}</td></tr>` : '';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
<h2 style="color:#0f5132">${escapeHtml(config.estateName)} – e-Receipt</h2>
<p>Dear ${escapeHtml(p.user.firstName)},</p>
<p>We have received your payment of <b>${formatNaira(p.amount)}</b> (${methodLabel(p.method)}).</p>
<p>Receipt number: <b>${p.receiptNo}</b><br>Membership ID: ${p.user.membershipId}<br>Date: ${p.paidAt.toISOString().slice(0, 10)}</p>
<table style="border-collapse:collapse;width:100%;border:1px solid #ddd">${rows}${creditRow}</table>
<p><a href="${config.appUrl}/receipts/${p.id}">View or print your receipt</a></p>
<p style="color:#666">${escapeHtml(config.estateName)} Residents' Association</p></div>`;
    await sendEmail({ to: p.user.email, subject: `Receipt ${p.receiptNo} – ${formatNaira(p.amount)}`, text, html });
  } catch (err) {
    console.error(`[receipt] payment ${paymentId}: ${err.message}`);
  }
}
