import { Router } from 'express';
import { prisma, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { dateOnly, todayIso } from '../lib/dates.js';
import { parse, paging, pageQuery, z, id, kobo, text, optionalText, isoDate } from '../lib/validate.js';
import { requireAdmin, requireResident, requireAuth } from '../middleware/auth.js';
import { movePayment, paymentInclude, previewAllocation, recordPayment, reversePayment } from '../services/ledger.js';
import { notifyPayment } from '../services/receipts.js';
import { confirmOnlinePayment, initializeOnlinePayment } from '../services/onlinePayments.js';
import { validSignature } from '../services/paystack.js';
import { memberSearch } from './residents.js';
import { asDate, asKobo, asText, isBlank, readSheet, sendXlsx, sheetUpload, templateBuffer } from '../lib/sheet.js';
import { MAX_AMOUNT } from '../lib/money.js';

export const router = Router();

// ---- Paystack webhook (public; authenticated by HMAC signature) -------------

router.post('/webhook', async (req, res) => {
  if (!validSignature(req.rawBody, req.get('x-paystack-signature'))) return res.status(401).json({ error: 'Bad signature' });
  const event = req.body;
  if (event?.event === 'charge.success' && event.data?.reference) {
    try {
      await confirmOnlinePayment(String(event.data.reference));
    } catch (err) {
      // A 5xx makes Paystack retry later, which is safe: a reference applies once.
      console.error(`[webhook] ${event.data.reference}: ${err.message}`);
      return res.status(500).json({ error: 'Could not process' });
    }
  }
  res.json({ ok: true });
});

// ---- Resident: pay online --------------------------------------------------

router.post('/initialize', requireResident, async (req, res) => {
  const body = parse(z.object({ invoiceId: id.optional().nullable(), amount: kobo.optional() }), req.body ?? {});
  res.json(await initializeOnlinePayment(req.user, body));
});

// Browser fallback after the popup closes (and the only path on localhost).
router.get('/verify/:reference', requireResident, async (req, res) => {
  const reference = parse(z.string().min(5).max(100), req.params.reference);
  const op = await prisma.onlinePayment.findUnique({ where: { reference } });
  if (!op || op.userId !== req.user.id) throw notFound('Payment not found');
  res.json(await confirmOnlinePayment(reference));
});

// ---- Receipts (admin, or the member the receipt belongs to) -----------------

router.get('/:id', requireAuth, async (req, res) => {
  const paymentId = parse(id, req.params.id);
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: paymentInclude });
  if (!payment) throw notFound('Receipt not found');
  if (req.user.role !== 'ADMIN' && payment.userId !== req.user.id) throw notFound('Receipt not found');
  res.json(payment);
});

// ---- Admin -----------------------------------------------------------------

const listQuery = pageQuery.extend({
  q: z.string().max(100).optional(),
  method: z.enum(['CASH', 'BANK_TRANSFER', 'POS', 'PAYSTACK', 'ACCOUNT_CREDIT']).optional(),
  status: z.enum(['COMPLETED', 'REVERSED']).optional(),
  userId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

router.get('/', requireAdmin, async (req, res) => {
  const q = parse(listQuery, req.query);
  const where = {
    ...(q.method ? { method: q.method } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.q ? { OR: [{ receiptNo: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q, mode: 'insensitive' } }, { user: memberSearch(q.q) }] } : {}),
  };
  if (q.from || q.to) where.paidAt = { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lt: new Date(dateOnly(q.to).getTime() + 86_400_000) } : {}) };
  const [total, rows, sums] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, orderBy: [{ paidAt: 'desc' }, { id: 'desc' }], include: paymentInclude, ...paging(q) }),
    prisma.payment.aggregate({ where: { ...where, status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' } }, _sum: { amount: true } }),
  ]);
  res.json({ total, page: q.page, pageSize: q.pageSize, rows, totals: { received: sums._sum.amount || 0 } });
});

const receiveBody = z.object({
  userId: id,
  amount: kobo,
  invoiceId: id.optional().nullable(),
  // Bills to settle first, in this order (e.g. every line of a debit note).
  invoiceIds: z.array(id).max(100).optional(),
});

router.post('/preview', requireAdmin, async (req, res) => {
  const body = parse(receiveBody, req.body);
  res.json(await previewAllocation(body.userId, body.amount, body.invoiceIds?.length ? body.invoiceIds : body.invoiceId ?? null));
});

// Receive Payment: credited to the member, allocated oldest-first (or to the
// chosen invoice first); any excess is kept as account credit.
router.post('/receive', requireAdmin, async (req, res) => {
  const body = parse(
    receiveBody.extend({
      method: z.enum(['CASH', 'BANK_TRANSFER', 'POS']),
      paidAt: isoDate,
      reference: optionalText(100),
      note: optionalText(500),
    }),
    req.body,
  );
  if (body.paidAt > todayIso()) throw badRequest('The payment date cannot be in the future');
  const member = await prisma.user.findUnique({ where: { id: body.userId }, select: { role: true } });
  if (!member) throw notFound('Member not found');
  if (member.role !== 'RESIDENT') throw badRequest('Payments can only be received from residents');
  const result = await transaction(async (tx) => {
    const r = await recordPayment(tx, {
      userId: body.userId,
      amount: body.amount,
      method: body.method,
      paidAt: new Date(`${body.paidAt}T12:00:00.000Z`),
      reference: body.reference,
      note: body.note,
      recordedById: req.user.id,
      invoiceId: body.invoiceId ?? null,
      invoiceIds: body.invoiceIds ?? null,
    });
    await audit(req, 'payment.receive', 'Payment', r.payment.id, { receiptNo: r.payment.receiptNo, amount: body.amount, method: body.method, credit: r.credit }, tx);
    return r;
  });
  await notifyPayment(result.payment.id);
  res.status(201).json({ payment: await prisma.payment.findUnique({ where: { id: result.payment.id }, include: paymentInclude }), credit: result.credit });
});

router.post('/:id/reverse', requireAdmin, async (req, res) => {
  const paymentId = parse(id, req.params.id);
  const body = parse(z.object({ reason: text(300) }), req.body);
  const payment = await reversePayment(paymentId, body.reason, req.user.id);
  await audit(req, 'payment.reverse', 'Payment', paymentId, { receiptNo: payment.receiptNo, amount: payment.amount, reason: body.reason, creditReceiptsUndone: payment.undone });
  res.json(payment);
});

// The member's bills a payment could be moved to: open ones and the ones it is on now.
router.get('/:id/move-options', requireAdmin, async (req, res) => {
  const paymentId = parse(id, req.params.id);
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { allocations: { where: { amount: { gt: 0 } } } } });
  if (!payment) throw notFound('Payment not found');
  const onIt = new Map();
  for (const a of payment.allocations) onIt.set(a.invoiceId, (onIt.get(a.invoiceId) || 0) + a.amount);
  const bills = await prisma.invoice.findMany({
    where: { userId: payment.userId, status: { not: 'VOID' }, OR: [{ status: { in: ['UNPAID', 'PARTIAL'] } }, { id: { in: [...onIt.keys()] } }] },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    include: { debitNote: { select: { id: true, noteNo: true, year: true } } },
  });
  res.json({ payment: { id: payment.id, receiptNo: payment.receiptNo, amount: payment.amount, status: payment.status, method: payment.method }, bills: bills.map((b) => ({ ...b, fromThisPayment: onIt.get(b.id) || 0 })) });
});

// Put a payment on different bills (e.g. meant for this year's debit note, not last year's).
router.post('/:id/move', requireAdmin, async (req, res) => {
  const paymentId = parse(id, req.params.id);
  const body = parse(z.object({ invoiceIds: z.array(id).min(1, 'choose at least one bill').max(100), dryRun: z.boolean().default(false), reason: optionalText(300) }), req.body);
  const r = await movePayment(paymentId, body.invoiceIds, req.user.id, { dryRun: body.dryRun });
  if (!body.dryRun) await audit(req, 'payment.move', 'Payment', paymentId, { receiptNo: r.payment.receiptNo, from: r.before, to: r.after.map((l) => ({ invoiceId: l.invoiceId, description: l.description, amount: l.amount })), credit: r.credit, reason: body.reason });
  res.json(r);
});

// ---- Upload a bank statement: receive many payments at once ------------------
// Each money-in row is matched to a member (LWE number, then phone, then name)
// and received exactly as on Receive Payment. A reference can be used once, and
// a row without one is skipped if the member already has a payment of the same
// amount on the same day, so uploading a statement twice receives nothing twice.

const STATEMENT_FIELDS = [
  { key: 'date', label: 'Date', required: true, aliases: ['transaction date', 'trans date', 'txn date', 'value date', 'posting date', 'date paid', 'payment date', 'tran date'] },
  { key: 'amount', label: 'Amount (₦)', required: true, aliases: ['amount', 'credit', 'credits', 'credit amount', 'deposit', 'deposits', 'money in', 'amount received', 'lodgement', 'lodgements', 'inflow', 'cr', 'credit ngn', 'amount paid'] },
  { key: 'membershipId', label: 'Membership ID', aliases: ['member id', 'lwe id', 'lwe number', 'member no', 'membership no', 'membership number'] },
  { key: 'name', label: 'Payer name', aliases: ['payer', 'name', 'member', 'member name', 'depositor', 'sender', 'from', 'remitter', 'paid by'] },
  { key: 'narration', label: 'Narration', aliases: ['description', 'details', 'remarks', 'remark', 'transaction details', 'particulars', 'memo', 'narrative', 'transaction description'] },
  { key: 'reference', label: 'Reference', text: true, aliases: ['ref', 'transaction reference', 'reference no', 'reference number', 'ref no', 'session id', 'transaction id', 'cheque no', 'tran id'] },
  { key: 'method', label: 'Method', aliases: ['payment method', 'channel', 'mode', 'type'] },
];

const METHOD_WORDS = { CASH: /cash/, POS: /pos|card/, BANK_TRANSFER: /transfer|bank|nip|trf|deposit|^$/ };

/** Finds the member a statement line belongs to. Returns { member } or { problem }. */
function matchMember(row, members) {
  const text = [row.membershipId, row.name, row.narration, row.reference].map(asText).join(' ');
  const byNumber = new Map(members.map((m) => [Number(m.membershipId.slice(4)), m]));
  const idCell = asText(row.membershipId);
  const fromCell = /^(?:lwe[\s-]*)?0*(\d{1,6})$/i.exec(idCell);
  const fromText = /\bLWE[\s-]*0*(\d{1,6})\b/i.exec(text);
  const n = fromCell ? Number(fromCell[1]) : fromText ? Number(fromText[1]) : null;
  if (n !== null) {
    const m = byNumber.get(n);
    return m ? { member: m, how: 'Membership ID' } : { problem: `No member LWE-${String(n).padStart(4, '0')}` };
  }
  if (idCell) return { problem: `"${idCell}" is not a membership ID (e.g. LWE-0007)` };
  // A Nigerian phone number in the text.
  const phones = [...text.matchAll(/(?:\+?234|0)([789][01]\d{8})/g)].map((p) => p[1]);
  for (const p of phones) {
    const hits = members.filter((m) => (m.phone || '').replace(/\D/g, '').endsWith(p));
    if (hits.length === 1) return { member: hits[0], how: 'Phone number' };
  }
  // Both names of exactly one member appear as words.
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1));
  const named = members.filter((m) => words.has(m.firstName.toLowerCase()) && words.has(m.lastName.toLowerCase()));
  if (named.length === 1) return { member: named[0], how: 'Name' };
  if (named.length > 1) return { problem: `Could be ${named.map((m) => m.membershipId).join(' or ')}; add a Membership ID column` };
  return { problem: 'Could not tell which member paid. Add their LWE number in a "Membership ID" column' };
}

router.get('/import/template', requireAdmin, async (_req, res) => {
  sendXlsx(res, 'payments_upload_template.xlsx', await templateBuffer({
    sheetName: 'Payments',
    fields: STATEMENT_FIELDS,
    examples: [
      { date: '03/11/2026', amount: 5000, membershipId: 'LWE-0007', name: 'Adaeze Okafor', narration: 'NIP transfer Nov dues', reference: 'NIP000123456', method: 'Bank transfer' },
      { date: '04/11/2026', amount: 15000, membershipId: '', name: 'Tunde Bello', narration: 'TRF FROM TUNDE BELLO LWE 12', reference: 'FT2611040001', method: 'Bank transfer' },
    ],
    notes: [
      'How to upload payments',
      '',
      'Easiest: download your estate account statement from internet banking as Excel or CSV and upload it as it is.',
      'Only money coming in is used (a Credit / Deposit / Amount column); debit lines are ignored.',
      'Each line is matched to a member by: a Membership ID column, else "LWE 12" written in the narration, else a phone number, else the member\'s first and last name.',
      'Lines that cannot be matched are listed so you can add the Membership ID and upload again.',
      'Each payment pays the member\'s oldest bills first; anything extra is kept as credit. A receipt is issued and the member is notified, exactly as on Receive Payment.',
      'A bank reference can be used once, so uploading the same statement twice does not record anything twice.',
    ],
  }));
});

router.post('/import', requireAdmin, sheetUpload, async (req, res) => {
  const opts = parse(z.object({ dryRun: z.enum(['true', 'false']).default('true') }), req.body);
  const { rows, ignored } = await readSheet(req.file, STATEMENT_FIELDS);
  const members = await prisma.user.findMany({ where: { role: 'RESIDENT' }, select: { id: true, membershipId: true, firstName: true, lastName: true, phone: true, isActive: true } });
  const errors = [];
  const skipped = [];
  const ready = [];
  let notMoneyIn = 0;
  const refsInFile = new Map();
  for (const { rowNumber: row, values } of rows) {
    // A debit line on a statement: no credit amount, or a negative one.
    if (isBlank(values.amount) || (typeof values.amount === 'number' ? values.amount <= 0 : /^\s*[-(]|^\s*0+(\.0+)?\s*$/.test(String(values.amount)))) { notMoneyIn++; continue; }
    const problems = [];
    const date = asDate(values.date);
    if (!date) problems.push(isBlank(values.date) ? 'Date is required' : `Date "${asText(values.date)}" is not a date we can read`);
    else if (date > todayIso()) problems.push(`Date ${date} is in the future`);
    const amount = asKobo(values.amount);
    if (!amount) problems.push(`Amount "${asText(values.amount)}" is not an amount above zero`);
    else if (amount > MAX_AMOUNT) problems.push('Amount is too large for one payment');
    const methodText = asText(values.method).toLowerCase();
    const method = Object.keys(METHOD_WORDS).find((k) => METHOD_WORDS[k].test(methodText));
    if (!method) problems.push(`Method "${asText(values.method)}" must be Bank transfer, Cash or POS`);
    const reference = asText(values.reference).slice(0, 100) || null;
    if (reference && refsInFile.has(reference)) problems.push(`Reference ${reference} is also on row ${refsInFile.get(reference)}`);
    if (reference) refsInFile.set(reference, row);
    const match = matchMember(values, members);
    if (match.problem) problems.push(match.problem);
    if (problems.length) { errors.push({ row, message: problems.join('; ') }); continue; }
    const m = match.member;
    ready.push({ row, date, amount, method, reference, note: asText(values.narration).slice(0, 300) || null, userId: m.id, membershipId: m.membershipId, name: `${m.firstName} ${m.lastName}`, matchedBy: match.how, inactive: !m.isActive });
  }
  // Already received? Same reference, or (no reference) same member, day and amount.
  const refs = ready.filter((r) => r.reference).map((r) => r.reference);
  const usedRefs = new Map((await prisma.payment.findMany({ where: { reference: { in: refs } }, select: { reference: true, receiptNo: true } })).map((p) => [p.reference, p.receiptNo]));
  const noRef = ready.filter((r) => !r.reference);
  const sameDay = noRef.length
    ? await prisma.payment.findMany({ where: { status: 'COMPLETED', userId: { in: noRef.map((r) => r.userId) }, paidAt: { gte: dateOnly(noRef.map((r) => r.date).sort()[0]) } }, select: { userId: true, amount: true, paidAt: true, receiptNo: true } })
    : [];
  const fresh = ready.filter((r) => {
    const why = r.reference
      ? usedRefs.has(r.reference) && `Reference already used on receipt ${usedRefs.get(r.reference)}`
      : (() => { const p = sameDay.find((p) => p.userId === r.userId && p.amount === r.amount && p.paidAt.toISOString().slice(0, 10) === r.date); return p && `${r.membershipId} already has a payment of this amount on ${r.date} (receipt ${p.receiptNo})`; })();
    if (why) skipped.push({ row: r.row, name: `${r.name} (${r.membershipId})`, message: why });
    return !why;
  });
  const total = fresh.reduce((s, r) => s + r.amount, 0);
  const summary = { total: rows.length, ignoredColumns: ignored, errors, skipped, notMoneyIn, amount: total };
  if (opts.dryRun === 'true') return res.json({ ...summary, ready: fresh });

  const created = [];
  for (const r of fresh) {
    try {
      const out = await transaction(async (tx) => {
        const p = await recordPayment(tx, { userId: r.userId, amount: r.amount, method: r.method, paidAt: new Date(`${r.date}T12:00:00.000Z`), reference: r.reference, note: r.note, recordedById: req.user.id });
        await audit(req, 'payment.receive', 'Payment', p.payment.id, { receiptNo: p.payment.receiptNo, amount: r.amount, method: r.method, credit: p.credit, imported: true }, tx);
        return p;
      });
      created.push({ ...r, receiptNo: out.payment.receiptNo, paymentId: out.payment.id, credit: out.credit });
    } catch (err) {
      if (err.status !== 409) throw err;
      skipped.push({ row: r.row, name: `${r.name} (${r.membershipId})`, message: err.message });
    }
  }
  for (const c of created) await notifyPayment(c.paymentId);
  await audit(req, 'payment.import', 'Payment', null, { file: req.file.originalname, rows: rows.length, received: created.length, amount: created.reduce((s, c) => s + c.amount, 0) });
  res.status(201).json({ ...summary, created });
});
