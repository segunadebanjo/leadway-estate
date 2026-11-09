import crypto from 'node:crypto';
import { config } from '../config.js';

// Thin Paystack client. Tests replace `paystack.initialize` / `paystack.verify`.

async function call(path, init = {}) {
  if (!config.paystack.secretKey) throw Object.assign(new Error('Online payments are not configured yet'), { status: 503 });
  const res = await fetch(`${config.paystack.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.paystack.secretKey}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw Object.assign(new Error(body.message || `Paystack error (HTTP ${res.status})`), { status: 502 });
  }
  return body.data;
}

export const paystack = {
  /** → { authorization_url, access_code, reference } */
  initialize({ email, amount, reference, metadata, callbackUrl }) {
    return call('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({ email, amount, reference, currency: 'NGN', metadata, callback_url: callbackUrl }),
    });
  },
  /** → Paystack transaction ({ status, amount, currency, reference, metadata, paid_at, … }) */
  verify(reference) {
    return call(`/transaction/verify/${encodeURIComponent(reference)}`);
  },
};

/** HMAC-SHA512 of the raw body with the secret key, compared in constant time. */
export function validSignature(rawBody, signature) {
  if (!config.paystack.secretKey || !rawBody || !signature) return false;
  const expected = crypto.createHmac('sha512', config.paystack.secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
