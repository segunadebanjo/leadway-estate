import { api } from '../../api.js';

/**
 * Start a Paystack payment: the server fixes the amount and returns an access
 * code; the popup collects card / bank / transfer / USSD. After it closes we
 * ask the server to verify (the webhook may already have done it).
 */
export async function payOnline({ invoiceId = null, amount } = {}) {
  const init = await api.post('/api/payments/initialize', { invoiceId, ...(amount ? { amount } : {}) });
  const { default: PaystackPop } = await import('@paystack/inline-js');
  return new Promise((resolve, reject) => {
    try {
      const popup = new PaystackPop();
      popup.resumeTransaction(init.accessCode, {
        onSuccess: async () => {
          try {
            resolve(await verifyWithRetry(init.reference));
          } catch (err) {
            reject(err);
          }
        },
        onCancel: () => resolve({ status: 'cancelled' }),
        onError: (e) => reject(new Error(e?.message || 'The payment window could not open')),
      });
    } catch {
      // Popup blocked or script unavailable: fall back to Paystack's hosted page.
      window.location.assign(init.authorizationUrl);
    }
  });
}

export async function verifyWithRetry(reference, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await api.get(`/api/payments/verify/${encodeURIComponent(reference)}`);
    if (r.status !== 'pending') return r;
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return { status: 'pending' };
}
