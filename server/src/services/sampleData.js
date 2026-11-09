import { prisma, transaction } from '../db.js';
import { conflict } from '../lib/errors.js';

// The sample ("demo") records that prisma/demo.js loads, and the one way to
// remove them again. Sample records are recognised by what demo.js writes:
// people by their exact @example.com e-mail, expenses and assets by their exact
// values *and* by being created in the same few minutes as the sample people.
// Everything an executive entered for real is left alone.

export const SAMPLE_PEOPLE = [
  ['Adebayo', 'Ogunleye', 'OWNER', 'A1', 'Palm Close'], ['Chioma', 'Nwosu', 'OWNER', 'A2', 'Palm Close'], ['Ibrahim', 'Musa', 'TENANT', 'A4', 'Palm Close'],
  ['Funke', 'Adeyemi', 'OWNER', 'B3', 'Cedar Avenue'], ['Emeka', 'Obi', 'OWNER', 'B5', 'Cedar Avenue'], ['Kemi', 'Bakare', 'TENANT', 'B6', 'Cedar Avenue'],
  ['Tunde', 'Lawal', 'OWNER', 'C1', 'Mango Street'], ['Ngozi', 'Eze', 'OWNER', 'C2', 'Mango Street'], ['Segun', 'Akinola', 'TENANT', 'C7', 'Mango Street'],
  ['Halima', 'Bello', 'OWNER', 'D2', 'Coral Road'], ['Yemi', 'Alade', 'OWNER', 'D4', 'Coral Road'], ['Obinna', 'Okeke', 'TENANT', 'D9', 'Coral Road'],
];
export const SAMPLE_GUARD_EMAIL = 'gate@example.com';
export const sampleEmail = (firstName, lastName) => `${firstName}.${lastName}@example.com`.toLowerCase();
const SAMPLE_EMAILS = [...SAMPLE_PEOPLE.map(([f, l]) => sampleEmail(f, l)), SAMPLE_GUARD_EMAIL];

export const SAMPLE_EXPENSES = [
  ['Security', 'Guard services', 'SafeGuard Ltd', 45_000_000],
  ['Electricity / Diesel', 'Diesel for estate generator', 'Total Energies', 18_000_000],
  ['Waste Disposal', 'Refuse collection', 'LAWMA-accredited PSP', 6_000_000],
  ['Repairs & Maintenance', 'Gate motor repair', 'Gatefix', 3_500_000],
];
export const SAMPLE_ASSET_NAMES = ['Generator 100kVA (Mikano)', 'Diesel', 'Street light bulbs (LED 100W)', 'Wheelbarrow'];
export const SAMPLE_FEE_CODE = 'ELECTRICITY_CONNECTION';

// demo.js writes everything within seconds; allow generous slack either side.
const WINDOW_MS = 30 * 60_000;

async function findSample(db = prisma) {
  const users = await db.user.findMany({ where: { email: { in: SAMPLE_EMAILS }, role: { not: 'ADMIN' } }, select: { id: true, createdAt: true } });
  if (!users.length) return null;
  const times = users.map((u) => u.createdAt.getTime());
  const created = { gte: new Date(Math.min(...times) - WINDOW_MS), lte: new Date(Math.max(...times) + WINDOW_MS) };
  const userIds = users.map((u) => u.id);
  const expenses = await db.expense.findMany({
    where: { createdAt: created, OR: SAMPLE_EXPENSES.map(([category, description, payee, amount]) => ({ category, description, payee, amount })) },
    select: { id: true },
  });
  const assets = await db.asset.findMany({ where: { createdAt: created, name: { in: SAMPLE_ASSET_NAMES } }, select: { id: true } });
  const feeType = await db.feeType.findFirst({ where: { code: SAMPLE_FEE_CODE, createdAt: created }, select: { id: true } });
  return { userIds, created, expenseIds: expenses.map((e) => e.id), assetIds: assets.map((a) => a.id), feeTypeId: feeType?.id ?? null };
}

/** What would be removed, or null when no sample data is loaded. */
export async function sampleDataSummary() {
  const s = await findSample();
  if (!s) return null;
  const member = { userId: { in: s.userIds } };
  const [residents, guards, invoices, payments, requests] = await Promise.all([
    prisma.user.count({ where: { id: { in: s.userIds }, role: 'RESIDENT' } }),
    prisma.user.count({ where: { id: { in: s.userIds }, role: 'SECURITY' } }),
    prisma.invoice.count({ where: member }),
    prisma.payment.count({ where: member }),
    prisma.serviceRequest.count({ where: member }),
  ]);
  return { residents, securityStaff: guards, invoices, payments, expenses: s.expenseIds.length, assets: s.assetIds.length, serviceRequests: requests };
}

/**
 * Delete the sample records and everything that hangs off them, all or
 * nothing. Returns the summary of what was removed, or null if there was none.
 */
export async function removeSampleData() {
  const summary = await sampleDataSummary();
  if (!summary) return null;
  await transaction(async (tx) => {
    const s = await findSample(tx);
    const ids = { in: s.userIds };
    const payments = (await tx.payment.findMany({ where: { userId: ids }, select: { id: true } })).map((p) => p.id);
    const invoices = (await tx.invoice.findMany({ where: { userId: ids }, select: { id: true } })).map((i) => i.id);
    await tx.paymentAllocation.deleteMany({ where: { OR: [{ paymentId: { in: payments } }, { invoiceId: { in: invoices } }] } });
    await tx.creditEntry.deleteMany({ where: { OR: [{ userId: ids }, { paymentId: { in: payments } }] } });
    await tx.onlinePayment.deleteMany({ where: { userId: ids } });
    await tx.payment.deleteMany({ where: { id: { in: payments } } });
    await tx.invoice.deleteMany({ where: { id: { in: invoices } } });
    await tx.serviceRequest.deleteMany({ where: { userId: ids } });
    await tx.visitorPass.deleteMany({ where: { hostId: ids } });
    await tx.notification.deleteMany({ where: { userId: ids } });
    await tx.asset.deleteMany({ where: { id: { in: s.assetIds } } }); // movements and maintenance go with them
    await tx.expense.deleteMany({ where: { id: { in: s.expenseIds } } });
    // A sample person who did something to a real record (e.g. the sample
    // guard logging a real stock movement) cannot be removed silently.
    const blockers = await tx.stockMovement.count({ where: { byId: ids } }) + await tx.expense.count({ where: { recordedById: ids } }) +
      await tx.document.count({ where: { uploadedById: ids } }) + await tx.announcement.count({ where: { sentById: ids } });
    if (blockers) throw conflict('Some real records were entered under a sample login, so the sample data was not removed.');
    await tx.user.deleteMany({ where: { id: ids } }); // reset tokens cascade; audit entries keep their text, actor becomes blank
    if (s.feeTypeId && !(await tx.invoice.count({ where: { feeTypeId: s.feeTypeId } }))) await tx.feeType.delete({ where: { id: s.feeTypeId } });
    // Let the next new member take the number after the highest one still in use,
    // so the real members are numbered straight on from the admin.
    await tx.$executeRaw`SELECT setval('membership_id_seq', GREATEST(COALESCE((SELECT MAX(substring("membershipId" from 5)::int) FROM "User" WHERE "membershipId" ~ '^LWE-[0-9]+$'), 0), 1), (SELECT COUNT(*) > 0 FROM "User" WHERE "membershipId" ~ '^LWE-[0-9]+$'))`;
  });
  return summary;
}
