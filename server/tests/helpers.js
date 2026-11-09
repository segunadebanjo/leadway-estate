import request from 'supertest';
import { prisma } from '../src/db.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/lib/auth.js';
import { outbox } from '../src/lib/messaging.js';
import { paystack } from '../src/services/paystack.js';

export { prisma, outbox, paystack };
export const app = createApp();

const TABLES = [
  'Setting', 'ReminderLog', 'PaymentPlan', 'HouseholdMember', 'Vehicle', 'PollVote', 'PollOption', 'Poll', 'MeetingAttendance', 'Meeting',
  'AuditLog', 'Notification', 'Announcement', 'VisitorPass', 'ServiceRequest', 'Document', 'MaintenanceLog', 'StockMovement',
  'Asset', 'Expense', 'OnlinePayment', 'CreditEntry', 'PaymentAllocation', 'Payment', 'Invoice', 'FeeType', 'PasswordResetToken', 'User',
];

export async function resetDb() {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE membership_id_seq RESTART WITH 1`);
  outbox.email.length = 0;
  outbox.sms.length = 0;
  await prisma.feeType.createMany({
    data: [
      { code: 'MONTHLY_DUE', name: 'Monthly Due', amount: 500_000, frequency: 'MONTHLY' },
      { code: 'ANNUAL_DEV_FEE', name: 'Annual Development Fee', amount: 4_000_000, frequency: 'ANNUAL' },
    ],
  });
}

export const PASSWORD = 'Passw0rd-123';
let hashed;

export async function createUser(over = {}) {
  hashed ??= await hashPassword(PASSWORD);
  const n = Math.random().toString(36).slice(2, 8);
  return prisma.user.create({
    data: { email: `u${n}@example.com`, firstName: 'Test', lastName: `User${n}`, passwordHash: hashed, mustChangePassword: false, role: 'RESIDENT', ...over },
  });
}

/** A supertest agent signed in as `user`, sending the CSRF header. */
export async function login(user, password = PASSWORD) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'fetch').send({ email: user.email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return wrap(agent);
}

export function anon() {
  return wrap(request.agent(app));
}

function wrap(agent) {
  const h = (r) => r.set('X-Requested-With', 'fetch');
  return {
    get: (u) => agent.get(u),
    post: (u, b) => h(agent.post(u)).send(b),
    patch: (u, b) => h(agent.patch(u)).send(b),
    delete: (u) => h(agent.delete(u)),
    raw: agent,
  };
}

/** Admin + n residents (billed for the current month and year). */
export async function setup({ residents = 1 } = {}) {
  await resetDb();
  const admin = await createUser({ role: 'ADMIN', firstName: 'Ada', lastName: 'Admin' });
  const people = [];
  for (let i = 0; i < residents; i++) people.push(await createUser({ firstName: `Res${i}`, lastName: `Ident${i}`, phone: `0803000000${i}` }));
  return { admin, residents: people, adminAgent: await login(admin) };
}

export async function invoiceFor(userId, amount, { dueDate = '2026-01-15', description = 'Test fee', period = null } = {}) {
  const ft = await prisma.feeType.findUnique({ where: { code: 'MONTHLY_DUE' } });
  return prisma.invoice.create({ data: { userId, feeTypeId: ft.id, amount, dueDate: new Date(`${dueDate}T00:00:00Z`), description, period } });
}

/** Ledger invariants that must hold after any sequence of operations. */
export async function assertLedgerConsistent(assert) {
  const invoices = await prisma.invoice.findMany({ include: { allocations: { include: { payment: true } } } });
  for (const inv of invoices) {
    const live = inv.allocations.filter((a) => a.payment.status === 'COMPLETED').reduce((s, a) => s + a.amount, 0);
    assert.equal(inv.amountPaid, live, `invoice ${inv.id} amountPaid matches its live allocations`);
    assert.ok(inv.amountPaid <= inv.amount);
  }
  const users = await prisma.user.findMany({ include: { creditEntries: true } });
  for (const u of users) assert.equal(u.creditBalance, u.creditEntries.reduce((s, c) => s + c.amount, 0), `credit ledger of user ${u.id}`);
  const payments = await prisma.payment.findMany({ where: { status: 'COMPLETED', method: { not: 'ACCOUNT_CREDIT' } }, include: { allocations: true, creditEntries: { where: { kind: 'OVERPAYMENT' } } } });
  for (const p of payments) {
    const placed = p.allocations.reduce((s, a) => s + a.amount, 0) + p.creditEntries.reduce((s, c) => s + c.amount, 0);
    assert.equal(placed, p.amount, `payment ${p.receiptNo} fully placed`);
  }
}
