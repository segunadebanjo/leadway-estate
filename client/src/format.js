const NGN = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 2 });

/** kobo → "₦5,000.00" */
export const naira = (kobo) => NGN.format((Number(kobo) || 0) / 100);

/** "5,000.50" / "5000" → 500050 kobo; null if not a valid positive amount. */
export function toKobo(input) {
  const s = String(input ?? '').replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const k = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(k) ? k : null;
}

/** kobo → "5000.50" for an input box */
export const koboToInput = (kobo) => ((Number(kobo) || 0) / 100).toFixed(2).replace(/\.00$/, '');

export function date(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });
}
export function dateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' });
}
export function todayIso() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
}
export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const fullName = (u) => (u ? `${u.firstName} ${u.lastName}` : '');

export const METHOD = { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', POS: 'POS', PAYSTACK: 'Online (Paystack)', ACCOUNT_CREDIT: 'Account credit' };
export const humanize = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
