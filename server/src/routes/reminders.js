import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { emailProvider, lastEmailError, sendEmail } from '../lib/messaging.js';
import { email as emailSchema, id, pageQuery, paging, parse, z } from '../lib/validate.js';
import { dueForAutomatic, listDebtors, sendReminders } from '../services/reminders.js';
import { getSetting, saveSetting } from '../services/settings.js';

// Admin: reminders to members who owe, and the app's connection settings.
export const router = Router();

router.get('/reminders', async (_req, res) => {
  const [debtors, settings] = await Promise.all([listDebtors(), getSetting('reminders')]);
  const autoIds = new Set(dueForAutomatic(debtors, settings).map((d) => d.id));
  res.json({
    debtors: debtors.map((d) => ({ ...d, inNextAutoRun: autoIds.has(d.id) })),
    settings,
    channels: { email: !!emailProvider(), sms: !!config.termii.apiKey },
  });
});

router.post('/reminders/send', async (req, res) => {
  const body = parse(z.object({ userIds: z.array(id).min(1, 'Choose at least one member').max(2000), email: z.boolean().default(true), sms: z.boolean().default(false) }), req.body);
  const wanted = new Set(body.userIds);
  const debtors = (await listDebtors()).filter((d) => wanted.has(d.id));
  if (!debtors.length) throw badRequest('None of the chosen members owe anything overdue now');
  const result = await sendReminders(debtors, { email: body.email, sms: body.sms });
  await audit(req, 'reminders.send', 'Reminder', null, { ...result, members: debtors.map((d) => d.membershipId) });
  res.json(result);
});

router.put('/reminders/settings', async (req, res) => {
  const body = parse(
    z.object({
      auto: z.boolean(),
      weekday: z.number().int().min(0).max(6),
      minDaysOverdue: z.number().int().min(0).max(365),
      minAmount: z.number().int().min(0).max(100_000_000),
      email: z.boolean(),
      sms: z.boolean(),
    }),
    req.body,
  );
  const saved = await saveSetting('reminders', body);
  await audit(req, 'reminders.settings', 'Setting', 'reminders', body);
  res.json(saved);
});

router.get('/reminders/history', async (req, res) => {
  const q = parse(pageQuery, req.query);
  const [total, rows] = await Promise.all([
    prisma.reminderLog.count(),
    prisma.reminderLog.findMany({ orderBy: { createdAt: 'desc' }, include: { user: { select: { membershipId: true, firstName: true, lastName: true } } }, ...paging(q) }),
  ]);
  res.json({ total, rows });
});

// ---- Connections: email, SMS, online payments ----------------------------------

router.get('/settings/status', (_req, res) => {
  const provider = emailProvider();
  res.json({
    email: { configured: !!provider, provider, from: config.emailFrom, lastError: lastEmailError },
    sms: { configured: !!config.termii.apiKey, senderId: config.termii.senderId },
    paystack: { configured: !!config.paystack.secretKey, testMode: config.paystack.secretKey.startsWith('sk_test_') },
    appUrl: config.appUrl,
  });
});

router.post('/settings/test-email', async (req, res) => {
  const body = parse(z.object({ to: emailSchema }), req.body);
  if (!emailProvider()) throw badRequest('Email is not set up yet. Follow the steps on this page first.');
  const ok = await sendEmail({
    to: body.to,
    subject: `${config.estateName}: test email`,
    text: `This is a test email from the ${config.estateName} app.\n\nIf you can read this, email is working: members will receive receipts, password resets and reminders.\n\n${config.appUrl}`,
  });
  await audit(req, 'settings.test_email', 'Setting', 'email', { to: body.to, ok });
  if (!ok) throw badRequest(`The email was not accepted: ${lastEmailError || 'unknown error'}`);
  res.json({ ok: true });
});
