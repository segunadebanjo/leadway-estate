// Seeds the two standard fee types and the first admin (password printed once).
// Safe to re-run (the online host runs it on every deploy): existing fee types
// are left alone, and no admin is created once any admin exists, so a
// leftover SEED_ADMIN_PASSWORD can never bring back an old sign-in.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { fixDatabaseUrlEnv } from '../src/lib/dbUrl.js';

fixDatabaseUrlEnv();

const prisma = new PrismaClient();

const FEE_TYPES = [
  { code: 'MONTHLY_DUE', name: 'Monthly Due', amount: 500_000, frequency: 'MONTHLY', description: 'Security, waste and common-area upkeep' },
  { code: 'ANNUAL_DEV_FEE', name: 'Annual Development Fee', amount: 4_000_000, frequency: 'ANNUAL', description: 'Roads, drainage and estate development' },
];

async function main() {
  for (const ft of FEE_TYPES) {
    await prisma.feeType.upsert({ where: { code: ft.code }, update: {}, create: ft });
  }
  console.log('Fee types: Monthly Due ₦5,000, Annual Development Fee ₦40,000');

  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@leadwayestate.ng').toLowerCase();
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } });
  if (existing) {
    console.log(`An admin already exists (${existing.membershipId}); no new admin created.`);
    return;
  }
  if (await prisma.user.findUnique({ where: { email } })) {
    console.log(`${email} is already a member, so it was not made the first admin. Set SEED_ADMIN_EMAIL to another address.`);
    return;
  }
  const password = process.env.SEED_ADMIN_PASSWORD || `Lwe-${crypto.randomBytes(6).toString('base64url')}-${crypto.randomInt(10, 99)}`;
  const admin = await prisma.user.create({
    data: {
      email,
      firstName: 'Estate',
      lastName: 'Administrator',
      role: 'ADMIN',
      passwordHash: await bcrypt.hash(password, 12),
      mustChangePassword: true, // a seeded password is always temporary
    },
  });
  console.log('\nFirst admin created (password must be changed at first sign-in):');
  console.log(`  Email:    ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) console.log(`  Password: ${password}`);
  console.log(`  ID:       ${admin.membershipId}\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
