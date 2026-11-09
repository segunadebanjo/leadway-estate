import { Router } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { escapeHtml, runLimited, sendEmail, sendSms } from '../lib/messaging.js';
import { parse, z, id, text } from '../lib/validate.js';

// Broadcast: in-app notification to every recipient, plus optional email and SMS.
export const router = Router();

router.get('/', async (_req, res) => {
  const rows = await prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { sentBy: { select: { firstName: true, lastName: true } } } });
  res.json({ rows });
});

router.post('/', async (req, res) => {
  const body = parse(
    z.object({
      title: text(150),
      body: text(5000),
      audience: z.enum(['ALL', 'OWNERS', 'TENANTS', 'SELECTED']),
      userIds: z.array(id).max(5000).optional(),
      sendEmail: z.boolean().default(false),
      sendSms: z.boolean().default(false),
    }),
    req.body,
  );
  const where = { role: 'RESIDENT', isActive: true };
  if (body.audience === 'OWNERS') where.occupancyType = 'OWNER';
  if (body.audience === 'TENANTS') where.occupancyType = 'TENANT';
  if (body.audience === 'SELECTED') {
    if (!body.userIds?.length) throw badRequest('Choose at least one resident');
    where.id = { in: body.userIds };
  }
  const recipients = await prisma.user.findMany({ where, select: { id: true, email: true, phone: true, firstName: true } });
  if (!recipients.length) throw badRequest('No active residents match that audience');

  const ann = await prisma.announcement.create({
    data: { title: body.title, body: body.body, audience: body.audience, sendEmail: body.sendEmail, sendSms: body.sendSms, recipients: recipients.length, sentById: req.user.id },
  });
  await prisma.notification.createMany({
    data: recipients.map((r) => ({ userId: r.id, title: body.title, body: body.body, announcementId: ann.id, link: '/notifications' })),
  });

  const counts = { emailSent: 0, emailFailed: 0, smsSent: 0, smsFailed: 0 };
  if (body.sendEmail) {
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px"><h2 style="color:#0f5132">${escapeHtml(body.title)}</h2>${escapeHtml(body.body).replace(/\n/g, '<br>')}<p style="color:#666;margin-top:24px">${escapeHtml(config.estateName)} Residents' Association</p></div>`;
    const results = await runLimited(recipients, 5, (r) => sendEmail({ to: r.email, subject: `${config.estateName}: ${body.title}`, text: `${body.body}\n\n${config.estateName}`, html }));
    counts.emailSent = results.filter(Boolean).length;
    counts.emailFailed = results.length - counts.emailSent;
  }
  if (body.sendSms) {
    const message = `${config.estateName}: ${body.title}. ${body.body}`.slice(0, 459);
    const withPhone = recipients.filter((r) => r.phone);
    const results = await runLimited(withPhone, 5, (r) => sendSms({ to: r.phone, message }));
    counts.smsSent = results.filter(Boolean).length;
    counts.smsFailed = recipients.length - counts.smsSent;
  }
  const saved = await prisma.announcement.update({ where: { id: ann.id }, data: counts });
  await audit(req, 'broadcast.send', 'Announcement', ann.id, { title: body.title, audience: body.audience, recipients: recipients.length, ...counts });
  res.status(201).json(saved);
});
