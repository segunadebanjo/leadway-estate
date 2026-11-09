import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import { app, assertLedgerConsistent, invoiceFor, login, paystack, prisma, setup } from './helpers.js';

// Paystack is stubbed: `paid` maps reference → the transaction Paystack would report.
let ctx;
let u;
let agent;
const paid = new Map();
let verifyCalls = 0;

paystack.initialize = async ({ amount, reference }) => ({ authorization_url: `https://checkout.paystack.com/${reference}`, access_code: `AC_${reference}`, reference, amount });
paystack.verify = async (reference) => {
  verifyCalls++;
  await new Promise((r) => setTimeout(r, 5));
  return paid.get(reference) || { reference, status: 'abandoned', amount: 0, currency: 'NGN' };
};

beforeEach(async () => {
  ctx = await setup({ residents: 2 });
  u = ctx.residents[0];
  agent = await login(u);
  paid.clear();
  verifyCalls = 0;
});
after(() => prisma.$disconnect());

const sign = (body) => crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
function webhook(payload, signature) {
  const raw = JSON.stringify(payload);
  return request(app).post('/api/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', signature ?? sign(raw)).send(raw);
}
function settle(init, over = {}) {
  paid.set(init.reference, { reference: init.reference, status: 'success', amount: init.amount, currency: 'NGN', paid_at: new Date().toISOString(), metadata: {}, ...over });
}

test('the server sets the amount; a resident cannot pay more than they owe', async () => {
  const inv = await invoiceFor(u.id, 500_000);
  const r = await agent.post('/api/payments/initialize', { invoiceId: inv.id });
  assert.equal(r.status, 200);
  assert.equal(r.body.amount, 500_000);
  assert.ok(r.body.accessCode);
  assert.equal((await agent.post('/api/payments/initialize', { invoiceId: inv.id, amount: 600_000 })).status, 400);
  assert.equal((await agent.post('/api/payments/initialize', { amount: 5_000 })).status, 400, 'below the ₦100 minimum');
  const other = await invoiceFor(ctx.residents[1].id, 500_000);
  assert.equal((await agent.post('/api/payments/initialize', { invoiceId: other.id })).status, 404, "cannot pay someone else's bill");
  assert.equal((await ctx.adminAgent.post('/api/payments/initialize', {})).status, 403);
});

test('webhook: bad signature is rejected; a valid one applies the payment once', async () => {
  const inv = await invoiceFor(u.id, 500_000);
  const init = (await agent.post('/api/payments/initialize', { invoiceId: inv.id })).body;
  settle(init);
  const payload = { event: 'charge.success', data: { reference: init.reference } };
  assert.equal((await webhook(payload, 'deadbeef')).status, 401);
  assert.equal((await webhook(payload)).status, 200);
  assert.equal((await webhook(payload)).status, 200, 'Paystack retry');
  assert.equal((await agent.get(`/api/payments/verify/${init.reference}`)).body.alreadyApplied, true, 'browser fallback after the webhook');
  const payments = await prisma.payment.findMany({ where: { userId: u.id } });
  assert.equal(payments.length, 1);
  assert.equal(payments[0].method, 'PAYSTACK');
  assert.equal(payments[0].reference, init.reference);
  assert.equal((await prisma.invoice.findUnique({ where: { id: inv.id } })).status, 'PAID');
  await assertLedgerConsistent(assert);
});

test('webhook, browser callback and retries arriving together credit once', async () => {
  const inv = await invoiceFor(u.id, 500_000);
  const init = (await agent.post('/api/payments/initialize', { invoiceId: inv.id })).body;
  settle(init);
  const payload = { event: 'charge.success', data: { reference: init.reference } };
  const results = await Promise.all([webhook(payload), webhook(payload), agent.get(`/api/payments/verify/${init.reference}`), agent.get(`/api/payments/verify/${init.reference}`), webhook(payload)]);
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
  assert.equal(await prisma.payment.count({ where: { userId: u.id } }), 1);
  assert.equal((await prisma.onlinePayment.findUnique({ where: { reference: init.reference } })).status, 'SUCCESS');
  await assertLedgerConsistent(assert);
});

test('nothing is credited without a successful server-side verification', async () => {
  const inv = await invoiceFor(u.id, 500_000);
  const init = (await agent.post('/api/payments/initialize', { invoiceId: inv.id })).body;
  // Webhook claims success, Paystack says abandoned.
  assert.equal((await webhook({ event: 'charge.success', data: { reference: init.reference } })).status, 200);
  assert.equal(await prisma.payment.count(), 0);
  assert.equal((await prisma.onlinePayment.findUnique({ where: { reference: init.reference } })).status, 'FAILED');
  // Wrong currency.
  const init2 = (await agent.post('/api/payments/initialize', { invoiceId: inv.id })).body;
  settle(init2, { currency: 'USD' });
  assert.equal((await agent.get(`/api/payments/verify/${init2.reference}`)).body.status, 'invalid');
  assert.equal(await prisma.payment.count(), 0);
  // Unknown reference.
  assert.equal((await webhook({ event: 'charge.success', data: { reference: 'NOT-OURS' } })).status, 200);
  assert.equal(await prisma.payment.count(), 0);
});

test("a resident cannot verify someone else's reference", async () => {
  await invoiceFor(u.id, 500_000);
  const init = (await agent.post('/api/payments/initialize', {})).body;
  const other = await login(ctx.residents[1]);
  assert.equal((await other.get(`/api/payments/verify/${init.reference}`)).status, 404);
});

test('a part-payment online, and an invoice settled meanwhile becomes credit', async () => {
  const inv = await invoiceFor(u.id, 500_000);
  const part = (await agent.post('/api/payments/initialize', { invoiceId: inv.id, amount: 200_000 })).body;
  settle(part);
  await agent.get(`/api/payments/verify/${part.reference}`);
  assert.equal((await prisma.invoice.findUnique({ where: { id: inv.id } })).status, 'PARTIAL');

  const rest = (await agent.post('/api/payments/initialize', { invoiceId: inv.id })).body;
  assert.equal(rest.amount, 300_000);
  // Meanwhile the office records cash for the same bill …
  await ctx.adminAgent.post('/api/payments/receive', { userId: u.id, amount: 300_000, method: 'CASH', paidAt: '2026-11-02' });
  // … and then the online payment lands: nothing is lost, it becomes credit.
  settle(rest);
  await webhook({ event: 'charge.success', data: { reference: rest.reference } });
  assert.equal((await prisma.user.findUnique({ where: { id: u.id } })).creditBalance, 300_000);
  await assertLedgerConsistent(assert);
});
