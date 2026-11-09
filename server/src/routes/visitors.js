import crypto from 'node:crypto';
import { Router } from 'express';
import { prisma, isUniqueViolation } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { parse, z, id, text, optionalText } from '../lib/validate.js';
import { requireResident, requireRole } from '../middleware/auth.js';
import { sendSms } from '../lib/messaging.js';
import { config } from '../config.js';

// Visitor gate passes. A resident issues a 6-digit code; security at the gate
// checks the visitor in and out. A code works only inside its validity window,
// and only while the pass is live.
export const router = Router();

const MAX_HOURS = 72;
const hostSelect = { select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, street: true, phone: true } };

router.get('/mine', requireResident, async (req, res) => {
  const rows = await prisma.visitorPass.findMany({ where: { hostId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ rows: rows.map(withState) });
});

router.post('/', requireResident, async (req, res) => {
  const body = parse(
    z.object({
      visitorName: text(100),
      visitorPhone: optionalText(30),
      purpose: optionalText(200),
      vehiclePlate: optionalText(20),
      validFrom: z.coerce.date().optional(),
      hours: z.number().int().min(1).max(MAX_HOURS).default(12),
      smsVisitor: z.boolean().default(false),
    }),
    req.body,
  );
  const validFrom = body.validFrom && body.validFrom > new Date() ? body.validFrom : new Date();
  if (validFrom.getTime() - Date.now() > 30 * 86_400_000) throw badRequest('A pass can be issued at most 30 days ahead');
  const validUntil = new Date(validFrom.getTime() + body.hours * 3600_000);
  let pass;
  for (let attempt = 0; attempt < 8 && !pass; attempt++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      pass = await prisma.visitorPass.create({
        data: { code, hostId: req.user.id, visitorName: body.visitorName, visitorPhone: body.visitorPhone, purpose: body.purpose, vehiclePlate: body.vehiclePlate, validFrom, validUntil },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  if (!pass) throw conflict('Could not issue a code; please try again');
  let smsSent = false;
  if (body.smsVisitor && body.visitorPhone) {
    smsSent = await sendSms({
      to: body.visitorPhone,
      message: `${config.estateName}: your gate code from ${req.user.firstName} is ${pass.code}. Valid until ${validUntil.toLocaleString('en-NG', { timeZone: config.timezone })}.`,
    });
  }
  res.status(201).json({ ...withState(pass), smsSent });
});

router.post('/:id/cancel', requireResident, async (req, res) => {
  const pId = parse(id, req.params.id);
  const r = await prisma.visitorPass.updateMany({ where: { id: pId, hostId: req.user.id, status: 'ACTIVE' }, data: { status: 'CANCELLED' } });
  if (!r.count) throw notFound('No active pass to cancel');
  res.json({ ok: true });
});

// ---- Gate (security staff and admins) ---------------------------------------

const gate = requireRole('SECURITY', 'ADMIN');

function withState(p) {
  const now = new Date();
  let state = p.status;
  if (p.status === 'ACTIVE' && now > p.validUntil) state = 'EXPIRED';
  else if (p.status === 'ACTIVE' && now < p.validFrom) state = 'NOT_YET_VALID';
  return { ...p, state };
}

router.post('/verify', gate, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'must be 6 digits') }), req.body);
  const pass = await prisma.visitorPass.findFirst({ where: { code, status: { in: ['ACTIVE', 'CHECKED_IN'] } }, include: { host: hostSelect } });
  if (!pass) throw notFound('No live pass with that code');
  res.json(withState(pass));
});

router.post('/:id/check-in', gate, async (req, res) => {
  const pId = parse(id, req.params.id);
  const now = new Date();
  // The validity window and status are part of the UPDATE, so a code is used once.
  const r = await prisma.visitorPass.updateMany({
    where: { id: pId, status: 'ACTIVE', validFrom: { lte: now }, validUntil: { gte: now } },
    data: { status: 'CHECKED_IN', checkedInAt: now, guardId: req.user.id },
  });
  if (!r.count) throw conflict('This pass is not valid for entry now (used, cancelled, expired or not yet valid)');
  const pass = await prisma.visitorPass.findUnique({ where: { id: pId }, include: { host: hostSelect } });
  await prisma.notification.create({ data: { userId: pass.hostId, title: `${pass.visitorName} has arrived`, body: `Checked in at the gate.`, link: '/visitors' } });
  res.json(withState(pass));
});

router.post('/:id/check-out', gate, async (req, res) => {
  const pId = parse(id, req.params.id);
  const r = await prisma.visitorPass.updateMany({ where: { id: pId, status: 'CHECKED_IN' }, data: { status: 'CHECKED_OUT', checkedOutAt: new Date() } });
  if (!r.count) throw conflict('This visitor is not checked in');
  res.json(withState(await prisma.visitorPass.findUnique({ where: { id: pId }, include: { host: hostSelect } })));
});

// Gate check: who does this car or person belong to? Matches registered
// vehicles, household members and residents (only active residents count).
router.get('/lookup', gate, async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().min(2, 'Type at least 2 characters').max(60) }), req.query).q;
  const key = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const host = { select: { ...hostSelect.select, isActive: true } };
  const [vehicles, people, residents] = await Promise.all([
    key.length >= 3 ? prisma.vehicle.findMany({ where: { plateKey: { contains: key } }, include: { user: host }, take: 10 }) : [],
    prisma.householdMember.findMany({ where: { name: { contains: q, mode: 'insensitive' } }, include: { user: host }, take: 10 }),
    prisma.user.findMany({
      where: { role: 'RESIDENT', OR: [{ firstName: { contains: q, mode: 'insensitive' } }, { lastName: { contains: q, mode: 'insensitive' } }, { plotNumber: { equals: q, mode: 'insensitive' } }] },
      select: { ...hostSelect.select, isActive: true },
      take: 10,
    }),
  ]);
  res.json({
    vehicles: vehicles.map((v) => ({ plateNumber: v.plateNumber, description: v.description, host: v.user })),
    people: people.map((p) => ({ name: p.name, relationship: p.relationship, phone: p.phone, host: p.user })),
    residents,
  });
});

// Today's expected and on-site visitors, plus a searchable log.
router.get('/', gate, async (req, res) => {
  const q = parse(z.object({ scope: z.enum(['today', 'onsite', 'all']).default('today'), q: z.string().max(100).optional() }), req.query);
  const now = new Date();
  const where =
    q.scope === 'onsite'
      ? { status: 'CHECKED_IN' }
      : q.scope === 'today'
        ? { OR: [{ status: 'CHECKED_IN' }, { status: 'ACTIVE', validFrom: { lte: new Date(now.getTime() + 12 * 3600_000) }, validUntil: { gte: now } }] }
        : {};
  if (q.q) where.AND = [{ OR: [{ visitorName: { contains: q.q, mode: 'insensitive' } }, { code: q.q }, { vehiclePlate: { contains: q.q, mode: 'insensitive' } }] }];
  const rows = await prisma.visitorPass.findMany({ where, include: { host: hostSelect }, orderBy: { validFrom: 'desc' }, take: 300 });
  res.json({ rows: rows.map(withState) });
});
