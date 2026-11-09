import { prisma, transaction, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { addDays, dateOnly, isoDate, localParts, monthName } from '../lib/dates.js';
import { applyCredit } from './ledger.js';

// Recurring billing. Idempotent through the unique (userId, feeTypeId, period)
// index: the run on the 1st creates the month's invoices, and any later run
// (nightly, at boot, or "Run billing now") only fills in members it missed.

let running = null;

/** Billable members: active residents. Admins and security staff are never billed. */
function billableMembers() {
  return prisma.user.findMany({ where: { role: 'RESIDENT', isActive: true }, select: { id: true } });
}

export function periodsFor(feeType, at) {
  const { year, month } = localParts(at);
  if (feeType.frequency === 'MONTHLY') {
    return {
      period: `${year}-${String(month).padStart(2, '0')}`,
      description: `${feeType.name} – ${monthName(month)} ${year}`,
      issueDate: isoDate({ year, month, day: 1 }),
    };
  }
  if (feeType.frequency === 'ANNUAL') {
    // Billed during the billing month only (a member who joins later in the year is not charged it).
    if (month !== config.annualBillingMonth) return null;
    return {
      period: String(year),
      description: `${feeType.name} – ${year}`,
      issueDate: isoDate({ year, month: config.annualBillingMonth, day: 1 }),
    };
  }
  return null;
}

/**
 * Create this period's invoices for every billable member. Returns counts.
 * Concurrent calls share one run.
 */
export function runBilling(at = new Date()) {
  running ??= doRunBilling(at).finally(() => {
    running = null;
  });
  return running;
}

async function doRunBilling(at) {
  const feeTypes = await prisma.feeType.findMany({ where: { isActive: true, frequency: { in: ['MONTHLY', 'ANNUAL'] } } });
  const members = await billableMembers();
  const result = { created: 0, skipped: 0, members: members.length, feeTypes: feeTypes.length };

  for (const ft of feeTypes) {
    const p = periodsFor(ft, at);
    if (!p) continue;
    const dueDate = dateOnly(addDays(p.issueDate, config.paymentTermsDays));
    const existing = new Set(
      (await prisma.invoice.findMany({ where: { feeTypeId: ft.id, period: p.period }, select: { userId: true } })).map((r) => r.userId),
    );
    for (const m of members) {
      if (existing.has(m.id)) {
        result.skipped++;
        continue;
      }
      const created = await createInvoice({ userId: m.id, feeType: ft, period: p.period, description: p.description, amount: ft.amount, dueDate });
      if (created) result.created++;
      else result.skipped++;
    }
  }
  return result;
}

/**
 * One invoice, then any account credit the member holds is applied to it.
 * Returns null if the (member, fee, period) invoice already exists.
 */
export async function createInvoice({ userId, feeType, period, description, amount, dueDate }) {
  try {
    return await transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: { userId, feeTypeId: feeType.id, period, description, amount, dueDate },
      });
      await applyCredit(tx, userId);
      return invoice;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

/** Bill a newly added (or reactivated) member for the current periods straight away. */
export async function billMemberNow(userId, at = new Date()) {
  const feeTypes = await prisma.feeType.findMany({ where: { isActive: true, frequency: { in: ['MONTHLY', 'ANNUAL'] } } });
  let created = 0;
  for (const ft of feeTypes) {
    const p = periodsFor(ft, at);
    if (!p) continue;
    const dueDate = dateOnly(addDays(p.issueDate, config.paymentTermsDays));
    if (await createInvoice({ userId, feeType: ft, period: p.period, description: p.description, amount: ft.amount, dueDate })) created++;
  }
  return created;
}
