import { Router } from 'express';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';
import { naira, sendCsv } from '../lib/csv.js';
import { toIso } from '../lib/dates.js';
import { id, isoDate, kobo, optionalText, parse, text, z } from '../lib/validate.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { getSetting, saveSetting } from '../services/settings.js';
import { getNote, issueDebitNotes, noteInclude, previewDebitNotes, summarise, voidNote } from '../services/debitNotes.js';
import { memberSearch } from './residents.js';

// Annual debit notes. Executives issue and cancel them; a member reads their own.
export const router = Router();

const issueBody = z.object({
  year: z.number().int().min(2020).max(2100),
  annualFeeTypeId: id.nullable().optional(),
  annualAmount: kobo.optional(),
  monthlyFeeTypeId: id.nullable().optional(),
  monthlyAmount: kobo.optional(),
  fromMonth: z.number().int().min(1).max(12).default(1),
  toMonth: z.number().int().min(1).max(12).default(12),
  monthlyDue: z.enum(['UPFRONT', 'MONTHLY']).default('UPFRONT'),
  issueDate: isoDate,
  dueDate: isoDate,
  message: optionalText(1000),
  userIds: z.array(id).max(5000).optional(), // none = every active resident
  notify: z.boolean().default(true),
});

router.get('/settings', requireAdmin, async (_req, res) => {
  res.json(await getSetting('debitNotes'));
});

router.post('/preview', requireAdmin, async (req, res) => {
  res.json(await previewDebitNotes(parse(issueBody, req.body)));
});

router.post('/', requireAdmin, async (req, res) => {
  const body = parse(issueBody, req.body);
  const result = await issueDebitNotes(body, req.user.id);
  await saveSetting('debitNotes', { annualFeeTypeId: body.annualFeeTypeId ?? null, monthlyFeeTypeId: body.monthlyFeeTypeId ?? null, monthlyDue: body.monthlyDue, message: body.message || '' });
  await audit(req, 'debit_note.issue', 'DebitNote', null, { year: body.year, issued: result.issued, skipped: result.skipped.length, total: result.total, members: body.userIds?.length || 'all' });
  res.status(201).json(result);
});

const listQuery = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  userId: id.optional(),
  q: z.string().max(100).optional(),
  status: z.enum(['OPEN', 'UNPAID', 'PARTIAL', 'PAID', 'VOID', 'OVERDUE']).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/** Notes for executives (any member) or for the signed-in member (their own). */
async function listNotes(where, status) {
  const notes = await prisma.debitNote.findMany({
    where,
    orderBy: [{ year: 'desc' }, { noteNo: 'asc' }],
    include: { user: noteInclude.user, invoices: { select: { amount: true, amountPaid: true, status: true, dueDate: true } } },
  });
  let rows = notes.map((n) => {
    const { invoices, ...rest } = summarise(n);
    return { ...rest, lines: invoices.filter((i) => i.status !== 'VOID').length };
  });
  if (status === 'OPEN') rows = rows.filter((r) => r.status === 'UNPAID' || r.status === 'PARTIAL');
  else if (status === 'OVERDUE') rows = rows.filter((r) => r.overdue > 0);
  else if (status) rows = rows.filter((r) => r.status === status);
  const live = rows.filter((r) => r.status !== 'VOID');
  const totals = { amount: 0, paid: 0, balance: 0 };
  for (const r of live) for (const k of Object.keys(totals)) totals[k] += r[k];
  return { rows, totals };
}

router.get('/', requireAuth, async (req, res) => {
  const q = parse(listQuery, req.query);
  const admin = req.user.role === 'ADMIN';
  if (!admin && req.user.role !== 'RESIDENT') throw forbidden();
  const where = {
    ...(q.year ? { year: q.year } : {}),
    ...(admin ? { ...(q.userId ? { userId: q.userId } : {}), ...(q.q ? { OR: [{ noteNo: { contains: q.q, mode: 'insensitive' } }, { user: memberSearch(q.q) }] } : {}) } : { userId: req.user.id }),
  };
  const out = await listNotes(where, q.status);
  if (q.format === 'csv') {
    return sendCsv(res, `debit_notes${q.year ? `_${q.year}` : ''}.csv`, [
      { key: 'noteNo', label: 'Debit note' },
      { key: 'membershipId', label: 'Membership ID', map: (r) => r.user.membershipId },
      { key: 'name', label: 'Member', map: (r) => `${r.user.firstName} ${r.user.lastName}` },
      { key: 'plot', label: 'Plot', map: (r) => r.user.plotNumber || '' },
      { key: 'year', label: 'Year' },
      { key: 'issueDate', label: 'Issued', map: (r) => toIso(r.issueDate) },
      { key: 'dueDate', label: 'Due', map: (r) => toIso(r.dueDate) },
      { key: 'amount', label: 'Amount (NGN)', map: (r) => naira(r.amount) },
      { key: 'paid', label: 'Paid (NGN)', map: (r) => naira(r.paid) },
      { key: 'balance', label: 'Balance (NGN)', map: (r) => naira(r.balance) },
      { key: 'status', label: 'Status' },
    ], out.rows);
  }
  res.json(out);
});

router.get('/:id', requireAuth, async (req, res) => {
  const note = await getNote(parse(id, req.params.id));
  if (req.user.role !== 'ADMIN' && note.userId !== req.user.id) throw notFound('Debit note not found'); // never reveal another member's bill
  res.json(note);
});

router.post('/:id/void', requireAdmin, async (req, res) => {
  const noteId = parse(id, req.params.id);
  const body = parse(z.object({ reason: text(300) }), req.body);
  const note = await voidNote(noteId, body.reason, req.user.id);
  await audit(req, 'debit_note.reverse', 'DebitNote', noteId, { noteNo: note.noteNo, reason: body.reason, paidMovedToCredit: note.released });
  res.json(await getNote(noteId));
});
