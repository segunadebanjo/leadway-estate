import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixDatabaseUrlEnv } from './lib/dbUrl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
fixDatabaseUrlEnv(env);
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see server/.env.example)`);
  return v;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

export const config = {
  isProd,
  isTest,
  port: Number(env.PORT || 4000),
  // On Render the public address is known automatically.
  appUrl: (env.APP_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:5173').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret,
  sessionHours: Number(env.SESSION_HOURS || 12),
  timezone: env.TZ_ESTATE || 'Africa/Lagos',
  estateName: env.ESTATE_NAME || 'Leadway Estate',
  estateAddress: env.ESTATE_ADDRESS || 'Mowe, Ogun State',
  // Month (1-12) in which the annual development fee is billed.
  annualBillingMonth: Number(env.ANNUAL_BILLING_MONTH || 1),
  // Days after the invoice date that a bill falls due.
  paymentTermsDays: Number(env.PAYMENT_TERMS_DAYS || 14),
  enableScheduler: env.ENABLE_SCHEDULER !== 'false' && !isTest,
  uploadDir: path.resolve(root, env.UPLOAD_DIR || 'uploads'),
  clientDist: path.resolve(root, '..', 'client', 'dist'),
  paystack: {
    secretKey: env.PAYSTACK_SECRET_KEY || '',
    publicKey: env.PAYSTACK_PUBLIC_KEY || '',
    baseUrl: env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.EMAIL_FROM || env.SMTP_FROM || 'Leadway Estate <no-reply@leadwayestate.ng>',
  },
  // Brevo sends email over HTTPS (works where SMTP ports are blocked, e.g. free hosting).
  brevo: {
    // Pasted keys often carry spaces, quotes or a line break; strip them.
    apiKey: String(env.BREVO_API_KEY || '').trim().replace(/^['"]|['"]$/g, '').trim(),
    baseUrl: env.BREVO_BASE_URL || 'https://api.brevo.com',
  },
  // "Leadway Estate <estate@example.com>": the sender shown on every email.
  emailFrom: env.EMAIL_FROM || env.SMTP_FROM || 'Leadway Estate <no-reply@leadwayestate.ng>',
  termii: {
    apiKey: env.TERMII_API_KEY || '',
    senderId: env.TERMII_SENDER_ID || 'Leadway',
    baseUrl: env.TERMII_BASE_URL || 'https://api.ng.termii.com',
  },
};
