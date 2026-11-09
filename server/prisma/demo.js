// Demo data for trying the app locally: residents, bills, payments, expenses,
// assets, requests and visitor passes. Refuses to run in production.
//   npm run db:seed && npm --prefix server run db:demo
import { pathToFileURL } from 'node:url';
import { prisma, transaction } from '../src/db.js';
import { hashPassword } from '../src/lib/auth.js';
import { runBilling, createInvoice } from '../src/services/billing.js';
import { recordPayment } from '../src/services/ledger.js';
import { SAMPLE_ASSET_NAMES, SAMPLE_EXPENSES, SAMPLE_FEE_CODE, SAMPLE_GUARD_EMAIL, SAMPLE_PEOPLE as PEOPLE, sampleEmail } from '../src/services/sampleData.js';



export async function loadDemoData() {
  if (await prisma.user.count({ where: { role: 'RESIDENT' } })) {
    console.log('Residents already exist – demo data not loaded.');
    return;
  }
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) throw new Error('Run npm run db:seed first');
  const passwordHash = await hashPassword('Resident123');
  const residents = [];
  for (const [firstName, lastName, occupancyType, plotNumber, street] of PEOPLE) {
    residents.push(await prisma.user.create({
      data: { firstName, lastName, occupancyType, plotNumber, street, email: sampleEmail(firstName, lastName), phone: `080${String(30000000 + residents.length * 7919).padStart(8, '0')}`, passwordHash, mustChangePassword: false, moveInDate: new Date('2023-03-01') },
    }));
  }
  await prisma.user.create({ data: { firstName: 'Gate', lastName: 'Officer', email: SAMPLE_GUARD_EMAIL, role: 'SECURITY', passwordHash, mustChangePassword: false } });

  // Six months of dues, as if the scheduler had been running.
  const now = new Date();
  for (let back = 5; back >= 0; back--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1, 1));
    await runBilling(d);
  }
  const ecf = await prisma.feeType.upsert({ where: { code: SAMPLE_FEE_CODE }, update: {}, create: { code: SAMPLE_FEE_CODE, name: 'Electricity Connection Fee', amount: 2_500_000, frequency: 'ONE_OFF' } });
  for (const r of residents.slice(0, 4)) await createInvoice({ userId: r.id, feeType: ecf, period: 'ECF-1', description: ecf.name, amount: ecf.amount, dueDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 28)) });

  // Payments: most pay, a few are behind, one has paid ahead.
  const pays = [30_000_00, 30_000_00, 10_000_00, 25_000_00, 30_000_00, 0, 20_000_00, 30_000_00, 5_000_00, 30_000_00, 40_000_00, 0];
  const methods = ['CASH', 'BANK_TRANSFER', 'POS'];
  for (let i = 0; i < residents.length; i++) {
    let left = pays[i];
    let k = 0;
    while (left > 0) {
      const amount = Math.min(left, 10_000_00);
      const paidAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4 + k, 5 + i, 10));
      await transaction((tx) => recordPayment(tx, { userId: residents[i].id, amount, method: methods[(i + k) % 3], paidAt: paidAt > now ? now : paidAt, reference: methods[(i + k) % 3] === 'CASH' ? null : `DEMO-${i}-${k}`, recordedById: admin.id }));
      left -= amount;
      k++;
    }
  }

  const exp = SAMPLE_EXPENSES;
  for (let m = 3; m >= 0; m--) {
    for (const [category, description, payee, amount] of exp.slice(0, m === 0 ? 4 : 3)) {
      await prisma.expense.create({ data: { date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 3)), category, description, payee, amount, recordedById: admin.id } });
    }
  }

  const [genName, dieselName, bulbsName, barrowName] = SAMPLE_ASSET_NAMES;
  const gen = await prisma.asset.create({ data: { name: genName, category: 'EQUIPMENT', quantity: 1, unit: 'unit', location: 'Generator house', purchaseCost: 1_250_000_000, purchaseDate: new Date('2022-06-10') } });
  await prisma.maintenanceLog.create({ data: { assetId: gen.id, date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 12)), description: 'Full service, oil and filters', cost: 18_500_000, performedBy: 'Mikano Service' } });
  const diesel = await prisma.asset.create({ data: { name: dieselName, category: 'CONSUMABLE', quantity: 60, minQuantity: 100, unit: 'litres', location: 'Generator house' } });
  await prisma.stockMovement.createMany({ data: [{ assetId: diesel.id, type: 'RESTOCKED', quantity: 400, byId: admin.id, note: 'Opening stock' }, { assetId: diesel.id, type: 'USED', quantity: -340, byId: admin.id, toLocation: 'Generator' }] });
  await prisma.asset.create({ data: { name: bulbsName, category: 'CONSUMABLE', quantity: 24, minQuantity: 10, unit: 'pcs', location: 'Store' } });
  await prisma.asset.create({ data: { name: barrowName, category: 'EQUIPMENT', quantity: 3, unit: 'pcs', location: 'Store' } });

  await prisma.serviceRequest.create({ data: { userId: residents[1].id, category: 'Electricity', title: 'Street light out by A2', description: 'The light on the pole opposite A2 has been off for a week.' } });
  await prisma.serviceRequest.create({ data: { userId: residents[4].id, category: 'Roads & Drainage', title: 'Blocked drain on Cedar Avenue', description: 'Water collects after rain near B5.', status: 'IN_PROGRESS', adminNote: 'Contractor booked for Saturday.' } });
  await prisma.visitorPass.create({ data: { code: '482913', hostId: residents[0].id, visitorName: 'Bisi Ogunleye', purpose: 'Family visit', validFrom: new Date(), validUntil: new Date(Date.now() + 12 * 3600_000) } });

  console.log(`Demo data loaded: ${residents.length} residents (password Resident123, e.g. ${residents[0].email}), gate@example.com (security).`);
}

// Run directly: node prisma/demo.js (refuses in production).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to load demo data in production.');
    process.exit(1);
  }
  loadDemoData().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
