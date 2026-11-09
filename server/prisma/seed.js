// Seeds the two standard fee types and the first admin (password printed once).
// Safe to re-run: existing fee types and an existing admin are left alone.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

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
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin ${email} already exists (${existing.membershipId}); password unchanged.`);
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
