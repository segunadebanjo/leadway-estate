import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUser, login, outbox, prisma, setup } from './helpers.js';

let ctx;
beforeEach(async () => {
  ctx = await setup({ residents: 3 });
});
after(() => prisma.$disconnect());

// ---- Documents ---------------------------------------------------------------

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test('documents: only real PDF/Word files are accepted, residents can download', async () => {
  const up = (buf, name) =>
    ctx.adminAgent.raw.post('/api/documents').set('X-Requested-With', 'fetch').field('title', 'AGM Minutes').field('category', 'Minutes').attach('file', buf, name);
  assert.equal((await up(Buffer.from('MZ\x90\x00 not a pdf'), 'minutes.pdf')).status, 400, 'renamed executable');
  assert.equal((await up(PDF, 'minutes.exe')).status, 400, 'wrong extension');
  assert.equal((await up(Buffer.from('PK\x03\x04 random zip'), 'x.docx')).status, 400, 'a zip that is not a Word file');
  const ok = await up(PDF, 'minutes.pdf');
  assert.equal(ok.status, 201);
  const resident = await login(ctx.residents[0]);
  const list = await resident.get('/api/documents');
  assert.equal(list.body.rows.length, 1);
  const dl = await resident.get(`/api/documents/${ok.body.id}/download`).buffer(true);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers['content-type'], 'application/pdf');
  assert.ok(Buffer.from(dl.body).subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(fs.existsSync(process.env.UPLOAD_DIR), false, 'no disk needed: the file is stored in the database');
  assert.equal(ok.body.content, undefined, 'file bytes are not echoed back');
  assert.equal((await resident.delete(`/api/documents/${ok.body.id}`)).status, 403);
  assert.equal((await ctx.adminAgent.delete(`/api/documents/${ok.body.id}`)).status, 200);
});

// ---- Broadcasts --------------------------------------------------------------

test('broadcast reaches the chosen audience by app, email and SMS', async () => {
  await prisma.user.update({ where: { id: ctx.residents[2].id }, data: { occupancyType: 'TENANT' } });
  outbox.email.length = 0;
  outbox.sms.length = 0;
  const r = await ctx.adminAgent.post('/api/broadcasts', { title: 'Water outage', body: 'No water on Saturday 9am–2pm.', audience: 'OWNERS', sendEmail: true, sendSms: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.recipients, 2);
  assert.equal(r.body.emailSent, 2);
  assert.equal(r.body.smsSent, 2);
  assert.equal(outbox.sms[0].to.startsWith('234'), true, 'phone normalised for Termii');
  const tenant = await login(ctx.residents[2]);
  assert.equal((await tenant.get('/api/me/notifications')).body.rows.length, 0);
  const owner = await login(ctx.residents[0]);
  const n = await owner.get('/api/me/notifications');
  assert.equal(n.body.unread, 1);
  await owner.post(`/api/me/notifications/${n.body.rows[0].id}/read`);
  assert.equal((await owner.get('/api/me/notifications')).body.unread, 0);
  const sel = await ctx.adminAgent.post('/api/broadcasts', { title: 'Hi', body: 'Just you', audience: 'SELECTED', userIds: [ctx.residents[2].id] });
  assert.equal(sel.body.recipients, 1);
});

// ---- Assets ------------------------------------------------------------------

test('assets: movement log drives quantity; low-stock alert; maintenance cost', async () => {
  const a = await ctx.adminAgent.post('/api/assets', { name: 'Diesel', category: 'CONSUMABLE', unit: 'litres', quantity: 200, minQuantity: 50, location: 'Generator house' });
  assert.equal(a.status, 201);
  const use = (q, more = {}) => ctx.adminAgent.post(`/api/assets/${a.body.id}/movements`, { type: 'USED', quantity: q, ...more });
  assert.equal((await use(500)).status, 400, 'cannot use more than is in stock');
  const r = await use(160, { toLocation: 'Main generator' });
  assert.equal(r.status, 201);
  assert.equal(r.body.asset.quantity, 40);
  assert.equal(r.body.asset.lowStock, true);
  assert.equal((await ctx.adminAgent.get('/api/assets?lowStock=true')).body.rows.length, 1);
  await ctx.adminAgent.post(`/api/assets/${a.body.id}/movements`, { type: 'RESTOCKED', quantity: 100 });
  await ctx.adminAgent.post(`/api/assets/${a.body.id}/movements`, { type: 'RELOCATED', quantity: 0, toLocation: 'Store B' });
  assert.equal((await ctx.adminAgent.post(`/api/assets/${a.body.id}/movements`, { type: 'ADJUSTED', quantity: 130 })).status, 400, 'adjustment needs a reason');
  await ctx.adminAgent.post(`/api/assets/${a.body.id}/movements`, { type: 'ADJUSTED', quantity: 130, note: 'Stock count' });
  const gen = await ctx.adminAgent.post('/api/assets', { name: 'Generator 60kVA', category: 'EQUIPMENT', quantity: 1 });
  await ctx.adminAgent.post(`/api/assets/${gen.body.id}/maintenance`, { date: '2026-10-01', description: 'Service', cost: 8_500_000, performedBy: 'Mikano' });
  const detail = await ctx.adminAgent.get(`/api/assets/${a.body.id}`);
  assert.equal(detail.body.quantity, 130);
  assert.equal(detail.body.location, 'Store B');
  assert.equal(detail.body.movements.length, 5, 'opening + used + restocked + relocated + adjusted');
  assert.equal(detail.body.movements.reduce((s, m) => s + m.quantity, 0), 130, 'the log adds up to the quantity');
  const reg = await ctx.adminAgent.get('/api/reports/assets');
  assert.equal(reg.body.rows.find((x) => x.name === 'Generator 60kVA').maintenanceCost, 8_500_000);
});

// ---- Visitor passes ------------------------------------------------------------

test('visitor pass: issue, verify, single check-in, check-out; cancelled and expired passes fail', async () => {
  const resident = await login(ctx.residents[0]);
  const guard = await login(await createUser({ role: 'SECURITY' }));
  const pass = await resident.post('/api/visitors', { visitorName: 'Emeka', visitorPhone: '08021112222', hours: 4, smsVisitor: true });
  assert.equal(pass.status, 201);
  assert.match(pass.body.code, /^\d{6}$/);
  assert.equal(pass.body.smsSent, true);
  const v = await guard.post('/api/visitors/verify', { code: pass.body.code });
  assert.equal(v.status, 200);
  assert.equal(v.body.host.id, ctx.residents[0].id);
  assert.equal(v.body.state, 'ACTIVE');
  const ins = await Promise.all([guard.post(`/api/visitors/${pass.body.id}/check-in`), guard.post(`/api/visitors/${pass.body.id}/check-in`)]);
  assert.deepEqual(ins.map((r) => r.status).sort(), [200, 409], 'a code admits once');
  assert.ok((await resident.get('/api/me/notifications')).body.rows.some((n) => n.title.includes('arrived')));
  assert.equal((await guard.post(`/api/visitors/${pass.body.id}/check-out`)).status, 200);
  assert.equal((await guard.post('/api/visitors/verify', { code: pass.body.code })).status, 404, 'a used code is dead');

  const p2 = (await resident.post('/api/visitors', { visitorName: 'Bisi' })).body;
  assert.equal((await resident.post(`/api/visitors/${p2.id}/cancel`)).status, 200);
  assert.equal((await guard.post(`/api/visitors/${p2.id}/check-in`)).status, 409);

  const p3 = (await resident.post('/api/visitors', { visitorName: 'Late' })).body;
  await prisma.visitorPass.update({ where: { id: p3.id }, data: { validUntil: new Date(Date.now() - 1000) } });
  assert.equal((await guard.post('/api/visitors/verify', { code: p3.code })).body.state, 'EXPIRED');
  assert.equal((await guard.post(`/api/visitors/${p3.id}/check-in`)).status, 409);

  const other = await login(ctx.residents[1]);
  assert.equal((await other.post(`/api/visitors/${p3.id}/cancel`)).status, 404, "cannot cancel another resident's pass");
});

// ---- Service requests ----------------------------------------------------------

test('service requests: resident raises, executives are notified, status updates reach the resident', async () => {
  const resident = await login(ctx.residents[0]);
  const r = await resident.post('/api/me/requests', { category: 'Electricity', title: 'Street light out', description: 'Pole 14 on Palm Close' });
  assert.equal(r.status, 201);
  assert.equal((await resident.post('/api/me/requests', { category: 'Nonsense', title: 'x', description: 'y' })).status, 400);
  assert.ok(await prisma.notification.findFirst({ where: { userId: ctx.admin.id, title: { contains: 'Street light' } } }));
  const u = await ctx.adminAgent.patch(`/api/admin/requests/${r.body.id}`, { status: 'RESOLVED', adminNote: 'Bulb replaced' });
  assert.equal(u.status, 200);
  assert.ok(u.body.resolvedAt);
  const notes = (await resident.get('/api/me/notifications')).body.rows;
  assert.ok(notes.some((n) => n.title.includes('resolved') && n.body === 'Bulb replaced'));
  assert.equal((await ctx.adminAgent.get('/api/admin/requests?status=ACTIVE')).body.rows.length, 0);
});

// ---- Expenses ------------------------------------------------------------------

test('expenses: CRUD with validation and audit', async () => {
  const e = await ctx.adminAgent.post('/api/admin/expenses', { date: '2026-11-03', category: 'Security', description: 'Guards – November', amount: 45_000_000, payee: 'SafeGuard Ltd' });
  assert.equal(e.status, 201);
  assert.equal((await ctx.adminAgent.post('/api/admin/expenses', { date: '2026-11-03', category: 'Bogus', description: 'x', amount: 1 })).status, 400);
  assert.equal((await ctx.adminAgent.patch(`/api/admin/expenses/${e.body.id}`, { amount: 46_000_000 })).body.amount, 46_000_000);
  const list = await ctx.adminAgent.get('/api/admin/expenses?from=2026-11-01&to=2026-11-30');
  assert.equal(list.body.totals.amount, 46_000_000);
  assert.equal((await ctx.adminAgent.delete(`/api/admin/expenses/${e.body.id}`)).status, 200);
  assert.equal(await prisma.auditLog.count({ where: { entity: 'Expense' } }), 3);
});
