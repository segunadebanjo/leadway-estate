import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient();
export { Prisma };

/**
 * Run `fn` in one database transaction. Money paths always lock the member
 * row first (lockMember), so every payment, credit move and billing write for
 * one member is serialised while different members proceed in parallel.
 */
export function transaction(fn, options = {}) {
  return prisma.$transaction(fn, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait: 10_000,
    timeout: 30_000,
    ...options,
  });
}

export async function lockMember(tx, userId) {
  const rows = await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
  return rows.length > 0;
}

export function isUniqueViolation(err, field) {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  if (!field) return true;
  const target = err.meta?.target;
  return Array.isArray(target) ? target.includes(field) : String(target || '').includes(field);
}
