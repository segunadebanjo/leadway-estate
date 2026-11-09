import { Router } from 'express';
import { prisma, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { dateOnly } from '../lib/dates.js';
import { parse, z, id, text, optionalText, isoDate } from '../lib/validate.js';
import { MAX_AMOUNT } from '../lib/money.js';
import { asDate, asKobo, asText, isBlank, readSheet, sendXlsx, sheetUpload, templateBuffer } from '../lib/sheet.js';

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
  const q = parse(z.object({ category: z.enum(['EQUIPMENT', 'CONSUMABLE']).optional(), lowStock: z.enum(['true', 'false']).optional(), includeInactive: z.enum(['true', 'false']).optional(), q: z.string().trim().max(100).optional() }), req.query);
  const search = q.q ? { OR: ['name', 'location', 'serialNumber', 'notes'].map((k) => ({ [k]: { contains: q.q, mode: 'insensitive' } })) } : {};
  const rows = await prisma.asset.findMany({
    where: { ...search, ...(q.category ? { category: q.category } : {}), ...(q.includeInactive === 'true' ? {} : { isActive: true }) },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
    include: { maintenance: { select: { cost: true } } },
  });
  let out = rows.map(({ maintenance, ...a }) => ({ ...a, lowStock: lowStock(a), maintenanceCost: maintenance.reduce((s, m) => s + m.cost, 0) }));
  if (q.lowStock === 'true') out = out.filter((a) => a.lowStock);
  res.json({ rows: out });
});

// ---- Upload a list of items (Excel or CSV) -----------------------------------

const ASSET_FIELDS = [
  { key: 'name', label: 'Item', required: true, aliases: ['name', 'item name', 'asset', 'asset name', 'description'] },
  { key: 'category', label: 'Category', required: true, aliases: ['type', 'kind', 'equipment or consumable'] },
  { key: 'quantity', label: 'Quantity', aliases: ['qty', 'quantity in stock', 'stock', 'number', 'no', 'count'] },
  { key: 'unit', label: 'Unit', aliases: ['units', 'uom', 'unit of measure'] },
  { key: 'minQuantity', label: 'Re-order level', aliases: ['reorder level', 'minimum', 'min quantity', 'minimum stock', 'reorder at'] },
  { key: 'location', label: 'Location', aliases: ['where', 'kept at', 'site'] },
  { key: 'serialNumber', label: 'Serial no.', text: true, aliases: ['serial', 'serial number', 'tag', 'asset tag'] },
  { key: 'purchaseDate', label: 'Purchase date', aliases: ['date bought', 'purchased', 'bought on', 'date purchased'] },
  { key: 'purchaseCost', label: 'Purchase cost (₦)', aliases: ['cost', 'price', 'purchase price', 'value', 'amount'] },
  { key: 'notes', label: 'Notes', aliases: ['note', 'comment', 'comments', 'remarks'] },
];

const wholeNumber = (v) => {
  if (isBlank(v)) return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
};

router.get('/import/template', async (_req, res) => {
  sendXlsx(res, 'assets_upload_template.xlsx', await templateBuffer({
    sheetName: 'Assets',
    fields: ASSET_FIELDS,
    examples: [
      { name: 'Generator 60kVA', category: 'Equipment', quantity: 1, unit: 'pcs', minQuantity: '', location: 'Power house', serialNumber: 'MK60-2291', purchaseDate: '12/01/2023', purchaseCost: 8500000, notes: '' },
      { name: 'Diesel', category: 'Consumable', quantity: 400, unit: 'litres', minQuantity: 100, location: 'Power house', serialNumber: '', purchaseDate: '', purchaseCost: '', notes: '' },
    ],
    notes: [
      'How to fill the Assets sheet',
      '',
      'One item per row. Item and Category are required.',
      'Category: Equipment (generators, pumps, CCTV, tools) or Consumable (diesel, chlorine, bulbs: things that get used up).',
      'Quantity is the number you have now; it is recorded as the opening stock. Unit: pcs, litres, bags…',
      'Re-order level: for consumables, a low-stock alert shows at or below this number.',
      'An item already in the app with the same name and location is skipped, so uploading twice adds nothing twice.',
    ],
  }));
});

router.post('/import', sheetUpload, async (req, res) => {
  const opts = parse(z.object({ dryRun: z.enum(['true', 'false']).default('true') }), req.body);
  const { rows, ignored } = await readSheet(req.file, ASSET_FIELDS);
  if (!rows.length) throw badRequest('The file has column headings but no items under them');
  const key = (name, location) => `${name.toLowerCase().trim()}|${(location || '').toLowerCase().trim()}`;
  const existing = new Set((await prisma.asset.findMany({ where: { isActive: true }, select: { name: true, location: true } })).map((a) => key(a.name, a.location)));
  const errors = [];
  const skipped = [];
  const ready = [];
  const seen = new Map();
  for (const { rowNumber: row, values } of rows) {
    const problems = [];
    const cat = asText(values.category).toLowerCase();
    const category = /^(equipment|equip|tool|tools|machine|machinery|fixed|e)$/.test(cat) ? 'EQUIPMENT' : /^(consumables?|supplies|supply|stock|c)$/.test(cat) ? 'CONSUMABLE' : null;
    if (!category) problems.push(`Category must be Equipment or Consumable (it says "${asText(values.category)}")`);
    const quantity = wholeNumber(values.quantity);
    if (quantity === null) problems.push(`Quantity "${asText(values.quantity)}" must be a whole number`);
    const minQuantity = wholeNumber(values.minQuantity);
    if (minQuantity === null) problems.push(`Re-order level "${asText(values.minQuantity)}" must be a whole number`);
    const purchaseDate = isBlank(values.purchaseDate) ? null : asDate(values.purchaseDate);
    if (!isBlank(values.purchaseDate) && !purchaseDate) problems.push(`Purchase date "${asText(values.purchaseDate)}" is not a date we can read`);
    const purchaseCost = isBlank(values.purchaseCost) ? null : asKobo(values.purchaseCost);
    if (!isBlank(values.purchaseCost) && !purchaseCost) problems.push(`Purchase cost "${asText(values.purchaseCost)}" is not an amount`);
    const r = assetBody.safeParse({
      name: asText(values.name), category: category || 'EQUIPMENT', unit: asText(values.unit) || 'pcs', minQuantity: minQuantity || 0,
      location: asText(values.location) || null, serialNumber: asText(values.serialNumber) || null, purchaseDate, purchaseCost, notes: asText(values.notes) || null,
    });
    if (!r.success) for (const i of r.error.issues) problems.push(`${ASSET_FIELDS.find((f) => f.key === i.path[0])?.label || i.path[0]} ${i.message}`);
    if (problems.length) { errors.push({ row, message: problems.join('; ') }); continue; }
    const k = key(r.data.name, r.data.location);
    if (existing.has(k)) { skipped.push({ row, name: r.data.name, message: `Already in the app${r.data.location ? ` at ${r.data.location}` : ''}` }); continue; }
    if (seen.has(k)) { errors.push({ row, message: `Same item and location as row ${seen.get(k)}; put them on one row with the total quantity` }); continue; }
    seen.set(k, row);
    ready.push({ row, ...r.data, quantity: quantity || 0 });
  }
  const summary = { total: rows.length, ignoredColumns: ignored, errors, skipped };
  if (opts.dryRun === 'true') return res.json({ ...summary, ready });
  const created = await transaction(async (tx) => {
    const out = [];
    for (const { row, quantity, ...data } of ready) {
      const a = await tx.asset.create({ data: { ...data, quantity, purchaseDate: data.purchaseDate ? dateOnly(data.purchaseDate) : null } });
      if (quantity > 0) await tx.stockMovement.create({ data: { assetId: a.id, type: 'RESTOCKED', quantity, toLocation: data.location, note: 'Opening quantity (upload)', byId: req.user.id } });
      out.push({ row, id: a.id, ...data, quantity });
    }
    await audit(req, 'asset.import', 'Asset', null, { file: req.file.originalname, rows: rows.length, created: out.length }, tx);
    return out;
  });
  res.status(201).json({ ...summary, created });
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
