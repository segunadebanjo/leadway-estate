import { Router } from 'express';
import { prisma, isUniqueViolation } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { id, optionalText, parse, text, z } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';

// The people living in a member's household and the vehicles they use, so the
// gate can tell who belongs. Residents manage their own; executives anyone's.
export const router = Router();
router.use(requireAuth);

export const RELATIONSHIPS = ['Spouse', 'Child', 'Parent', 'Relative', 'Domestic staff', 'Driver', 'Tenant / co-occupant', 'Other'];
const MAX_PEOPLE = 20;
const MAX_VEHICLES = 10;

export const plateKey = (plate) => String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The member being worked on: yourself, or (executives only) ?userId=. */
async function target(req) {
  const asked = req.query.userId ?? req.body?.userId;
  if (req.user.role === 'ADMIN' && asked) {
    const userId = parse(id, asked);
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!u) throw notFound('Member not found');
    return u.id;
  }
  if (req.user.role !== 'RESIDENT') throw forbidden('Only residents have a household');
  return req.user.id;
}

router.get('/', async (req, res) => {
  const userId = await target(req);
  const [people, vehicles] = await Promise.all([
    prisma.householdMember.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.vehicle.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
  ]);
  res.json({ people, vehicles, relationships: RELATIONSHIPS });
});

router.post('/people', async (req, res) => {
  const userId = await target(req);
  const body = parse(z.object({ name: text(120), relationship: z.enum(RELATIONSHIPS), phone: optionalText(30) }), req.body);
  if ((await prisma.householdMember.count({ where: { userId } })) >= MAX_PEOPLE) throw badRequest(`A household can list at most ${MAX_PEOPLE} people`);
  const row = await prisma.householdMember.create({ data: { userId, ...body } });
  await audit(req, 'household.add_person', 'User', userId, { name: body.name, relationship: body.relationship });
  res.status(201).json(row);
});

router.delete('/people/:id', async (req, res) => {
  const userId = await target(req);
  const row = await prisma.householdMember.findUnique({ where: { id: parse(id, req.params.id) } });
  if (!row || row.userId !== userId) throw notFound('Not found');
  await prisma.householdMember.delete({ where: { id: row.id } });
  await audit(req, 'household.remove_person', 'User', userId, { name: row.name });
  res.json({ ok: true });
});

router.post('/vehicles', async (req, res) => {
  const userId = await target(req);
  const body = parse(z.object({ plateNumber: text(20), description: optionalText(120) }), req.body);
  const key = plateKey(body.plateNumber);
  if (key.length < 4) throw badRequest('Enter the full plate number, e.g. KJA 123 AB');
  if ((await prisma.vehicle.count({ where: { userId } })) >= MAX_VEHICLES) throw badRequest(`A household can list at most ${MAX_VEHICLES} vehicles`);
  try {
    const row = await prisma.vehicle.create({ data: { userId, plateNumber: body.plateNumber.toUpperCase(), plateKey: key, description: body.description } });
    await audit(req, 'household.add_vehicle', 'User', userId, { plate: row.plateNumber });
    res.status(201).json(row);
  } catch (err) {
    if (!isUniqueViolation(err, 'plateKey')) throw err;
    const other = await prisma.vehicle.findUnique({ where: { plateKey: key }, include: { user: { select: { membershipId: true } } } });
    throw conflict(req.user.role === 'ADMIN' ? `That plate is already registered to ${other?.user.membershipId}` : 'That plate is already registered to another household. Ask the estate office.');
  }
});

router.delete('/vehicles/:id', async (req, res) => {
  const userId = await target(req);
  const row = await prisma.vehicle.findUnique({ where: { id: parse(id, req.params.id) } });
  if (!row || row.userId !== userId) throw notFound('Not found');
  await prisma.vehicle.delete({ where: { id: row.id } });
  await audit(req, 'household.remove_vehicle', 'User', userId, { plate: row.plateNumber });
  res.json({ ok: true });
});
