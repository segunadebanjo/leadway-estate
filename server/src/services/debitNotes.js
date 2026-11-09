import { prisma, transaction, lockMember, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { dateOnly, isoDate, monthName, toIso, todayIso } from '../lib/dates.js';
import { formatNaira, invoiceBalance, sum } from '../lib/money.js';
import { runLimited, sendEmail } from '../lib/messaging.js';
import { applyCredit } from './ledger.js';

// Annual debit notes: one per member per year, e.g. the annual due plus the
// security fee for January to December. Each line is an ordinary Invoice
// (period "2027" for the annual due, "2027-01" … "2027-12" for each month),
// so payments settle the lines through the same ledger as every other bill,
// and the monthly billing run never bills a month twice: the
// (member, fee, period) invoice already exists.

let running = null;

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The lines a note for `year` should carry. `monthlyDue` "UPFRONT": every
 * month is due on the note's due date; "MONTHLY": each month falls due on the
 * same day of that month.
 */
export function plannedLines(o) {
  const lines = [];
  if (o.annualFee) {
    lines.push({ feeType: o.annualFee, period: String(o.year), description: `${o.annualFee.name} – ${o.year}`, amount: o.annualAmount, dueDate: o.dueDate });
  }
  if (o.monthlyFee) {
    const day = Number(o.dueDate.slice(8, 10));
    for (let m = o.fromMonth; m <= o.toMonth; m++) {
      const due = o.monthlyDue === 'MONTHLY' ? isoDate({ year: o.year, month: m, day: Math.min(day, daysInMonth(o.year, m)) }) : o.dueDate;
      lines.push({
        feeType: o.monthlyFee,
        period: `${o.year}-${String(m).padStart(2, '0')}`,
        description: `${o.monthlyFee.name} – ${monthName(m)} ${o.year}`,
        amount: o.monthlyAmount,
        dueDate: due,
      });
    }
  }
  return lines;
}

/**
 * For one member: which lines are new, which existing bills (e.g. a month the
 * monthly run already billed) join the note, and which are left out because
 * they are on another note or were voided.
 */
function planMember(lines, existing) {
  const out = { create: [], attach: [], skipped: [] };
  for (const l of lines) {
    const inv = existing.get(`${l.feeType.id}|${l.period}`);
    if (!inv) out.create.push(l);
    else if (inv.status === 'VOID') out.skipped.push({ description: l.description, reason: 'voided earlier' });
    else if (inv.debitNoteId) out.skipped.push({ description: l.description, reason: `already on ${inv.debitNote?.noteNo || 'another debit note'}` });
    else out.attach.push(inv);
  }
  out.total = sum(out.create.map((l) => l.amount)) + sum(out.attach.map((i) => i.amount));
  return out;
}

async function resolveOptions(body) {
  const year = body.year;
  const [annualFee, monthlyFee] = await Promise.all([
    body.annualFeeTypeId ? prisma.feeType.findUnique({ where: { id: body.annualFeeTypeId } }) : null,
    body.monthlyFeeTypeId ? prisma.feeType.findUnique({ where: { id: body.monthlyFeeTypeId } }) : null,
  ]);
  if (body.annualFeeTypeId && !annualFee) throw badRequest('Choose the annual due from the fee types');
  if (body.monthlyFeeTypeId && !monthlyFee) throw badRequest('Choose the monthly fee (e.g. security fee) from the fee types');
  if (!annualFee && !monthlyFee) throw badRequest('Choose an annual due, a monthly fee, or both');
  if (annualFee && monthlyFee && annualFee.id === monthlyFee.id) throw badRequest('The annual due and the monthly fee must be different fee types');
  if (body.fromMonth > body.toMonth) throw badRequest('The first month must come before the last month');
  if (Number(body.dueDate.slice(0, 4)) < year - 1 || Number(body.dueDate.slice(0, 4)) > year) throw badRequest(`The due date should be in ${year} (or late ${year - 1})`);
  return {
    ...body,
    annualFee,
    monthlyFee,
    annualAmount: annualFee ? body.annualAmount ?? annualFee.amount : 0,
    monthlyAmount: monthlyFee ? body.monthlyAmount ?? monthlyFee.amount : 0,
  };
}

async function membersFor(body) {
  return prisma.user.findMany({
    where: { role: 'RESIDENT', isActive: true, ...(body.userIds?.length ? { id: { in: body.userIds } } : {}) },
    select: { id: true, membershipId: true, firstName: true, lastName: true, email: true, plotNumber: true },
    orderBy: { membershipId: 'asc' },
  });
}

async function existingByMember(o, userIds) {
  const feeTypeIds = [o.annualFee?.id, o.monthlyFee?.id].filter(Boolean);
  const rows = await prisma.invoice.findMany({
    where: { userId: { in: userIds }, feeTypeId: { in: feeTypeIds }, period: { startsWith: String(o.year) } },
    include: { debitNote: { select: { noteNo: true } } },
  });
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.userId)) map.set(r.userId, new Map());
    map.get(r.userId).set(`${r.feeTypeId}|${r.period}`, r);
  }
  return map;
}

/** What issuing would do, member by member, without saving anything. */
export async function previewDebitNotes(body) {
  const o = await resolveOptions(body);
  const lines = plannedLines(o);
  const members = await membersFor(body);
  if (!members.length) throw badRequest('No active residents to bill');
  const existing = await existingByMember(o, members.map((m) => m.id));
  const ready = [];
  const skipped = [];
  for (const m of members) {
    const p = planMember(lines, existing.get(m.id) || new Map());
    if (p.create.length + p.attach.length === 0) skipped.push({ ...m, reason: p.skipped[0]?.reason ? `Nothing left to bill (${p.skipped[0].reason})` : 'Nothing to bill' });
    else ready.push({ ...m, newLines: p.create.length, existingLines: p.attach.length, leftOut: p.skipped, total: p.total });
  }
  return {
    year: o.year,
    lines: lines.map((l) => ({ description: l.description, amount: l.amount, dueDate: l.dueDate })),
    perMember: sum(lines.map((l) => l.amount)),
    ready,
    skipped,
    total: sum(ready.map((r) => r.total)),
  };
}

async function nextNoteNo(tx, year) {
  const last = await tx.debitNote.findFirst({ where: { noteNo: { startsWith: `DN-${year}-` } }, orderBy: { noteNo: 'desc' }, select: { noteNo: true } });
  const n = last ? Number(last.noteNo.split('-')[2]) + 1 : 1;
  return `DN-${year}-${String(n).padStart(4, '0')}`;
}

/** Issue the notes. One transaction per member; concurrent calls share one run. */
export function issueDebitNotes(body, actorId) {
  if (running) throw conflict('Debit notes are already being issued; wait a moment and try again');
  running = doIssue(body, actorId).finally(() => {
    running = null;
  });
  return running;
}

async function doIssue(body, actorId) {
  const o = await resolveOptions(body);
  const lines = plannedLines(o);
  const members = await membersFor(body);
  if (!members.length) throw badRequest('No active residents to bill');
  const issued = [];
  const skipped = [];
  for (const m of members) {
    const note = await issueOne(o, lines, m, actorId);
    if (note) issued.push({ ...m, noteId: note.id, noteNo: note.noteNo, total: note.total });
    else skipped.push({ ...m, reason: 'Nothing left to bill' });
  }
  if (body.notify && issued.length) await notifyIssued(issued, o);
  return { issued: issued.length, skipped, total: sum(issued.map((i) => i.total)), notes: issued };
}

async function issueOne(o, lines, member, actorId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await transaction(async (tx) => {
        await lockMember(tx, member.id);
        const existing = await tx.invoice.findMany({
          where: { userId: member.id, feeTypeId: { in: [o.annualFee?.id, o.monthlyFee?.id].filter(Boolean) }, period: { startsWith: String(o.year) } },
          include: { debitNote: { select: { noteNo: true } } },
        });
        const p = planMember(lines, new Map(existing.map((r) => [`${r.feeTypeId}|${r.period}`, r])));
        if (p.create.length + p.attach.length === 0) return null;
        const note = await tx.debitNote.create({
          data: { noteNo: await nextNoteNo(tx, o.year), userId: member.id, year: o.year, issueDate: dateOnly(o.issueDate), dueDate: dateOnly(o.dueDate), message: o.message || null, createdById: actorId },
        });
        for (const l of p.create) {
          await tx.invoice.create({
            data: { userId: member.id, feeTypeId: l.feeType.id, period: l.period, description: l.description, amount: l.amount, dueDate: dateOnly(l.dueDate), debitNoteId: note.id },
          });
        }
        if (p.attach.length) await tx.invoice.updateMany({ where: { id: { in: p.attach.map((i) => i.id) }, debitNoteId: null }, data: { debitNoteId: note.id } });
        // Any credit the member holds (e.g. paid in advance) settles the note at once.
        await applyCredit(tx, member.id, actorId);
        return { ...note, total: p.total };
      });
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 2) continue; // a note number or a month was taken meanwhile: re-plan
      throw err;
    }
  }
  return null;
}

async function notifyIssued(issued, o) {
  const users = await prisma.user.findMany({ where: { id: { in: issued.map((i) => i.id) } }, select: { id: true, email: true, firstName: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  await runLimited(issued, 4, async (n) => {
    const u = byId.get(n.id);
    const link = `${config.appUrl}/debit-notes/${n.noteId}`;
    await prisma.notification.create({
      data: { userId: n.id, title: `Debit note ${n.noteNo}: ${formatNaira(n.total)} for ${o.year}`, body: `Your ${o.year} bill is ready, due by ${o.dueDate}. Payments are taken off it automatically.`, link: `/debit-notes/${n.noteId}` },
    });
    if (u?.email) {
      await sendEmail({
        to: u.email,
        subject: `${config.estateName}: debit note ${n.noteNo} for ${o.year}`,
        text: [
          `Dear ${u.firstName},`,
          '',
          `Your debit note ${n.noteNo} for ${o.year} is ready: ${formatNaira(n.total)}, due by ${o.dueDate}.`,
          o.message ? `\n${o.message}\n` : '',
          `See or print it, and pay online: ${link}`,
          '',
          'Every payment you make is taken off the balance automatically.',
          '',
          config.estateName,
        ].join('\n'),
      }).catch(() => null);
    }
  });
}

// ---- Reading -----------------------------------------------------------------

export const noteInclude = {
  user: { select: { id: true, membershipId: true, firstName: true, lastName: true, email: true, phone: true, plotNumber: true, street: true } },
  createdBy: { select: { firstName: true, lastName: true } },
  invoices: {
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    include: { allocations: { where: { payment: { status: 'COMPLETED' } }, include: { payment: { select: { id: true, receiptNo: true, paidAt: true, method: true } } } } },
  },
};

/** Totals and status worked out from the note's lines. */
export function summarise(note, today = todayIso()) {
  const live = note.invoices.filter((i) => i.status !== 'VOID');
  const amount = sum(live.map((i) => i.amount));
  const paid = sum(live.map((i) => i.amountPaid));
  const balance = sum(live.map(invoiceBalance));
  const overdue = sum(live.filter((i) => toIso(i.dueDate) < today).map(invoiceBalance));
  let status = 'UNPAID';
  if (note.status === 'VOID') status = 'VOID';
  else if (balance === 0) status = 'PAID';
  else if (paid > 0) status = 'PARTIAL';
  return { ...note, amount, paid, balance, overdue, status, noteStatus: note.status };
}

export async function getNote(id) {
  const note = await prisma.debitNote.findUnique({ where: { id }, include: noteInclude });
  if (!note) throw notFound('Debit note not found');
  const receipts = new Map();
  for (const inv of note.invoices) for (const a of inv.allocations) {
    const r = receipts.get(a.payment.id) || { ...a.payment, amount: 0 };
    r.amount += a.amount;
    receipts.set(a.payment.id, r);
  }
  return { ...summarise(note), receipts: [...receipts.values()].sort((a, b) => a.paidAt - b.paidAt), estate: { name: config.estateName, address: config.estateAddress } };
}

// ---- Voiding -----------------------------------------------------------------

/**
 * Cancel a note issued by mistake. Refused once anything has been paid on it.
 * Its lines are voided and their period freed, so the note can be issued again.
 */
export async function voidNote(id, reason) {
  return transaction(async (tx) => {
    const head = await tx.debitNote.findUnique({ where: { id }, select: { userId: true } });
    if (!head) throw notFound('Debit note not found');
    await lockMember(tx, head.userId);
    const note = await tx.debitNote.findUniqueOrThrow({ where: { id }, include: { invoices: true } });
    if (note.status === 'VOID') throw conflict('This debit note is already cancelled');
    if (note.invoices.some((i) => i.status !== 'VOID' && i.amountPaid > 0)) {
      throw conflict('Payments have already been taken off this debit note. Reverse those receipts first (member page → Payments), then cancel it.');
    }
    for (const inv of note.invoices.filter((i) => i.status !== 'VOID')) {
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'VOID', period: null, voidReason: `Debit note ${note.noteNo} cancelled: ${reason}` } });
    }
    return tx.debitNote.update({ where: { id }, data: { status: 'VOID', voidReason: reason } });
  });
}
