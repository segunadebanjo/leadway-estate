// All amounts are integer kobo. The API accepts and returns kobo; the client formats.

export const MAX_AMOUNT = 1_000_000_000; // ₦10,000,000 per entry: keeps every value well inside Int

export function formatNaira(kobo) {
  const n = Number(kobo || 0) / 100;
  return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function sum(values) {
  return values.reduce((a, b) => a + (b || 0), 0);
}

export function invoiceBalance(inv) {
  return inv.status === 'VOID' ? 0 : inv.amount - inv.amountPaid;
}

export function invoiceStatusFor(amount, amountPaid) {
  if (amountPaid <= 0) return 'UNPAID';
  if (amountPaid >= amount) return 'PAID';
  return 'PARTIAL';
}
