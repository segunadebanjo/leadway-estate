import nodemailer from 'nodemailer';
import { config } from '../config.js';

// Email (SMTP) and SMS (Termii). Without credentials nothing is sent: messages
// are logged outside production, and `outbox` records them so tests can read them.

export const outbox = { email: [], sms: [] };

let transporter;
function getTransporter() {
  if (!config.smtp.host) return null;
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  return transporter;
}

/** Returns true when the message was accepted for delivery. Never throws. */
export async function sendEmail({ to, subject, text, html }) {
  if (!to) return false;
  if (config.isTest) {
    outbox.email.push({ to, subject, text, html });
    return true;
  }
  const t = getTransporter();
  if (!t) {
    if (!config.isProd) console.log(`[email not configured] to=${to} subject=${subject}\n${text}`);
    return false;
  }
  try {
    await t.sendMail({ from: config.smtp.from, to, subject, text, html });
    return true;
  } catch (err) {
    console.error(`[email] ${to}: ${err.message}`);
    return false;
  }
}

/** Nigerian numbers to the 234XXXXXXXXXX form Termii expects; null if not a usable number. */
export function normalisePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0') && p.length === 11) p = '234' + p.slice(1);
  return /^234\d{10}$/.test(p) ? p : null;
}

export async function sendSms({ to, message }) {
  const phone = normalisePhone(to);
  if (!phone) return false;
  if (config.isTest) {
    outbox.sms.push({ to: phone, message });
    return true;
  }
  if (!config.termii.apiKey) {
    if (!config.isProd) console.log(`[sms not configured] to=${phone}: ${message}`);
    return false;
  }
  try {
    const res = await fetch(`${config.termii.baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.termii.apiKey,
        to: phone,
        from: config.termii.senderId,
        sms: message,
        type: 'plain',
        channel: 'generic',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[sms] ${phone}: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[sms] ${phone}: ${err.message}`);
    return false;
  }
}

/** Run async jobs with limited concurrency (bulk broadcasts). */
export async function runLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
