import { Router } from 'express';
import { prisma, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { dateOnly } from '../lib/dates.js';
import { parse, z, id, text, optionalText, isoDate } from '../lib/validate.js';
import { MAX_AMOUNT } from '../lib/money.js';

// Assets: equipment and consumables, quantity tracking through a movement log,
// maintenance log with cost, low-stock alerts.
export const router = Router();

const assetBody = z.object({
  name: text(120),
  category: z.enum(['EQUIPMENT', 'CONSUMABLE']),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  minQuantity: z.number().int().min(0).max(1_000_000).default(0),
  location: optionalText(120),
  serialNumber: optionalText(80),
  purchaseDate: isoDate.optional().nullable(),
  purchaseCost: z.number().int().min(0).max(MAX_AMOUNT).optional().nullable(),
  notes: optionalText(1000),
});

const lowStock = (a) => a.category === 'CONSUMABLE' && a.quantity <= a.minQuantity;

router.get('/', async (req, res) => {
  const q = parse(z.object({ category: z.enum(['EQUIPMENT', 'CONSUMABLE']).optional(), lowStock: z.enum(['true', 'false']).optional(), includeInactive: z.enum(['true', 'false']).optional() }), req.query);
  const rows = await prisma.asset.findMany({
    where: { ...(q.category ? { category: q.category } : {}), ...(q.includeInactive === 'true' ? {} : { isActive: true }) },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: { maintenance: { select: { cost: true } } },
  });
  let out = rows.map(({ maintenance, ...a }) => ({ ...a, lowStock: lowStock(a), maintenanceCost: maintenance.reduce((s, m) => s + m.cost, 0) }));
  if (q.lowStock === 'true') out = out.filter((a) => a.lowStock);
  res.json({ rows: out });
});

router.get('/:id', async (req, res) => {
  const assetId = parse(id, req.params.id);
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: {
      movements: { orderBy: { createdAt: 'desc' }, include: { by: { select: { firstName: true, lastName: true } } } },
      maintenance: { orderBy: { date: 'desc' } },
    },
  });
  if (!asset) throw notFound('Asset not found');
  res.json({ ...asset, lowStock: lowStock(asset) });
});

router.post('/', async (req, res) => {
  const body = parse(assetBody.extend({ quantity: z.number().int().min(0).max(1_000_000).default(0) }), req.body);
  const asset = await transaction(async (tx) => {
    const a = await tx.asset.create({ data: { ...body, purchaseDate: body.purchaseDate ? dateOnly(body.purchaseDate) : null } });
    if (body.quantity > 0) {
      await tx.stockMovement.create({ data: { assetId: a.id, type: 'RESTOCKED', quantity: body.quantity, toLocation: body.location, note: 'Opening quantity', byId: req.user.id } });
    }
    return a;
  });
  await audit(req, 'asset.create', 'Asset', asset.id, { name: asset.name, quantity: asset.quantity });
  res.status(201).json(asset);
});

// Quantity is not editable here: it only moves through the movement log.
router.patch('/:id', async (req, res) => {
  const assetId = parse(id, req.params.id);
  const body = parse(assetBody.partial().extend({ isActive: z.boolean().optional() }), req.body);
  const data = { ...body };
  if ('purchaseDate' in body) data.purchaseDate = body.purchaseDate ? dateOnly(body.purchaseDate) : null;
  const asset = await prisma.asset.update({ where: { id: assetId }, data }).catch(() => null);
  if (!asset) throw notFound('Asset not found');
  await audit(req, 'asset.update', 'Asset', assetId, body);
  res.json(asset);
});

router.post('/:id/movements', async (req, res) => {
  const assetId = parse(id, req.params.id);
  const body = parse(
    z.object({
      type: z.enum(['USED', 'RESTOCKED', 'RELOCATED', 'ADJUSTED']),
      quantity: z.number().int().min(0).max(1_000_000), // USED/RESTOCKED/RELOCATED: how many; ADJUSTED: the counted quantity
      toLocation: optionalText(120), // where it was deployed / moved to
      note: optionalText(500),
    }),
    req.body,
  );
  const result = await transaction(async (tx) => {
    const rows = await tx.$queryRaw`SELECT id, quantity, location FROM "Asset" WHERE id = ${assetId} FOR UPDATE`;
    if (!rows.length) throw notFound('Asset not found');
    const { quantity: current, location } = rows[0];
    let delta = 0;
    let newLocation = location;
    if (body.type === 'USED') {
      if (body.quantity < 1) throw badRequest('Enter how many were used');
      if (body.quantity > current) throw badRequest(`Only ${current} in stock`);
      delta = -body.quantity;
    } else if (body.type === 'RESTOCKED') {
      if (body.quantity < 1) throw badRequest('Enter how many were added');
      delta = body.quantity;
    } else if (body.type === 'RELOCATED') {
      if (!body.toLocation) throw badRequest('Say where it was moved to');
      newLocation = body.toLocation;
    } else {
      if (!body.note) throw badRequest('Give a reason for the stock adjustment');
      delta = body.quantity - current;
    }
    const movement = await tx.stockMovement.create({
      data: { assetId, type: body.type, quantity: delta, fromLocation: location, toLocation: body.toLocation ?? (body.type === 'RELOCATED' ? newLocation : null), note: body.note, byId: req.user.id },
    });
    const asset = await tx.asset.update({ where: { id: assetId }, data: { quantity: current + delta, location: newLocation } });
    return { movement, asset };
  });
  res.status(201).json({ ...result, asset: { ...result.asset, lowStock: lowStock(result.asset) } });
});

router.post('/:id/maintenance', async (req, res) => {
  const assetId = parse(id, req.params.id);
  const body = parse(z.object({ date: isoDate, description: text(500), cost: z.number().int().min(0).max(MAX_AMOUNT).default(0), performedBy: optionalText(120) }), req.body);
  if (!(await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset not found');
  const row = await prisma.maintenanceLog.create({ data: { ...body, date: dateOnly(body.date), assetId } });
  await audit(req, 'asset.maintenance', 'Asset', assetId, body);
  res.status(201).json(row);
});
