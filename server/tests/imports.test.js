import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createUser, login, prisma, setup } from './helpers.js';
import { asDate, asKobo, asPhone, parseCsv } from '../src/lib/sheet.js';

after(() => prisma.$disconnect());

const upload = (agent, url, buf, name, fields = {}) => {
  let r = agent.raw.post(url).set('X-Requested-With', 'fetch');
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', buf, name);
};

test('cell readers: Nigerian dates, phones that lost their 0, naira amounts, CSV quoting', () => {
  assert.equal(asDate('15/03/2024'), '2024-03-15');
  assert.equal(asDate('2024-03-15'), '2024-03-15');
  assert.equal(asDate('5 Mar 2024'), '2024-03-05');
  assert.equal(asDate(new Date(Date.UTC(2024, 2, 15))), '2024-03-15');
  assert.equal(asDate(45366), '2024-03-15');
  assert.equal(asDate('31/02/2024'), null);
  assert.equal(asDate('next week'), null);
  assert.equal(asPhone(8031234567), '08031234567');
  assert.equal(asPhone('0803 123 4567'), '0803 123 4567');
  assert.equal(asKobo('₦12,500.50'), 1_250_050);
  assert.equal(asKobo(1500), 150_000);
  assert.equal(asKobo('-20'), null);
  assert.equal(asKobo('0'), null);
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']]);
});

test('members upload: check first, then add; bad rows reported, duplicates skipped, each new member billed', async () => {
  const ctx = await setup({ residents: 0 });
  await createUser({ email: 'already@here.ng', firstName: 'Old', lastName: 'Timer' });

  const template = await ctx.adminAgent.raw.get('/api/residents/import/template').buffer(true).parse((res, cb) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
  assert.equal(template.status, 200);
  const wbT = new ExcelJS.Workbook();
  await wbT.xlsx.load(template.body);
  assert.match(String(wbT.worksheets[0].getRow(1).getCell(1).value), /First name/);

  // Own spreadsheet: other column names and order, a title row above the headings, Excel dates and numbers.
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('List');
  ws.addRow(['Leadway Estate residents 2026']);
  ws.addRow(['S/N', 'Surname', 'First Name', 'E-mail Address', 'Mobile', 'House No', 'Address', 'Owner/Tenant', 'Move-in date']);
  ws.addRow([1, 'Okafor', 'Adaeze', 'Adaeze.Okafor@Gmail.com', 8031234567, 14, 'Leadway Road', 'Landlord', new Date(Date.UTC(2021, 2, 15))]);
  ws.addRow([2, 'Bello', 'Tunde', 'tunde@yahoo.com', '08059876543', '7B', 'Unity Close', 'tenant', '']);
  ws.addRow([3, 'Timer', 'Old', 'already@here.ng', '', '', '', '', '']);
  ws.addRow([4, 'Nomail', 'Ngozi', '', '', '', '', 'Owner', '']);
  ws.addRow([5, 'Bad', 'Date', 'bad.date@x.ng', '', '', '', 'Visitor', 'soon']);
  ws.addRow([6, 'Twin', 'Tunde', 'TUNDE@yahoo.com', '', '', '', '', '']);
  ws.addRow([]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const check = await upload(ctx.adminAgent, '/api/residents/import', buf, 'residents.xlsx');
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.total, 6);
  assert.deepEqual(check.body.ready.map((r) => [r.row, r.email, r.phone, r.plotNumber, r.occupancyType, r.moveInDate]), [
    [3, 'adaeze.okafor@gmail.com', '08031234567', '14', 'OWNER', '2021-03-15'],
    [4, 'tunde@yahoo.com', '08059876543', '7B', 'TENANT', null],
  ]);
  assert.deepEqual(check.body.skipped.map((s) => s.row), [5]);
  assert.deepEqual(check.body.errors.map((e) => e.row), [6, 7, 8]);
  assert.equal(check.body.errors[0].message, "Email is required (it is the member's sign-in name)");
  assert.match(check.body.errors[1].message, /Owner or Tenant/);
  assert.match(check.body.errors[1].message, /Moved in/);
  assert.match(check.body.errors[2].message, /also on row 4/);
  assert.deepEqual(check.body.ignoredColumns, ['S/N']);
  assert.equal(await prisma.user.count(), 2, 'checking saves nothing');

  const add = await upload(ctx.adminAgent, '/api/residents/import', buf, 'residents.xlsx', { dryRun: 'false' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.deepEqual(add.body.created.map((c) => c.membershipId), ['LWE-0003', 'LWE-0004']);
  assert.ok(add.body.created.every((c) => c.temporaryPassword && c.invoicesCreated >= 1));
  const tunde = await prisma.user.findUnique({ where: { email: 'tunde@yahoo.com' } });
  assert.equal(tunde.mustChangePassword, true);
  assert.ok(await prisma.auditLog.findFirst({ where: { action: 'member.import' } }));

  // The new member can sign in with the password from the list.
  const agent = await login(tunde, add.body.created[1].temporaryPassword);
  assert.equal((await agent.get('/api/auth/me')).status, 200);

  // Uploading the same file again adds nobody.
  const again = await upload(ctx.adminAgent, '/api/residents/import', buf, 'residents.xlsx', { dryRun: 'false' });
  assert.equal(again.body.created.length, 0);
  assert.equal(again.body.skipped.length, 4, 'the earlier rows, plus the twin row whose email now exists');

  // CSV works too; residents cannot upload; wrong files are refused clearly.
  const csv = Buffer.from('First name,Last name,Email\r\nChidi,Eze,chidi@eze.ng\r\n');
  assert.equal((await upload(ctx.adminAgent, '/api/residents/import', csv, 'm.csv')).body.ready.length, 1);
  assert.equal((await upload(agent, '/api/residents/import', csv, 'm.csv')).status, 403);
  const noHead = await upload(ctx.adminAgent, '/api/residents/import', Buffer.from('Name,Phone\r\nX,1\r\n'), 'm.csv');
  assert.equal(noHead.status, 400);
  assert.match(noHead.body.error, /First name/);
  assert.equal((await upload(ctx.adminAgent, '/api/residents/import', Buffer.from('not excel'), 'm.xlsx')).status, 400);
  assert.equal((await upload(ctx.adminAgent, '/api/residents/import', csv, 'm.pdf')).status, 400);
});

test('expenses upload: categories matched loosely, amounts in naira, re-upload does not double count', async () => {
  const ctx = await setup({ residents: 0 });
  const csv = Buffer.from([
    'Date,Category,Description,Amount (₦),Payee,Reference',
    '03/11/2026,security,Night guards,"150,000",Shield Ltd,PV-001',
    '05/11/2026,Electricity/Diesel,Diesel 200 litres,₦240000.50,,',
    '06/11/2026,Parties,End of year party,5000,,',
    '07/11/2099,Water,Borehole repair,1000,,',
    ',Water,No date,1000,,',
  ].join('\r\n'));
  const check = await upload(ctx.adminAgent, '/api/admin/expenses/import', csv, 'spend.csv');
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.ready.map((r) => [r.date, r.category, r.amount]), [['2026-11-03', 'Security', 15_000_000], ['2026-11-05', 'Electricity / Diesel', 24_000_050]]);
  assert.equal(check.body.amount, 39_000_050);
  assert.deepEqual(check.body.errors.map((e) => e.row), [4, 5, 6]);
  assert.match(check.body.errors[0].message, /Category "Parties"/);
  assert.match(check.body.errors[1].message, /future/);
  assert.equal(await prisma.expense.count(), 0);

  const add = await upload(ctx.adminAgent, '/api/admin/expenses/import', csv, 'spend.csv', { dryRun: 'false' });
  assert.equal(add.status, 201);
  assert.equal(await prisma.expense.count(), 2);
  const again = await upload(ctx.adminAgent, '/api/admin/expenses/import', csv, 'spend.csv', { dryRun: 'false' });
  assert.equal(again.body.created.length, 0);
  assert.equal(again.body.skipped.length, 2);
  assert.equal(await prisma.expense.count(), 2);

  const found = await ctx.adminAgent.get('/api/admin/expenses?from=2026-11-01&to=2026-11-30&q=shield');
  assert.deepEqual(found.body.rows.map((e) => e.description), ['Night guards']);
  assert.equal((await ctx.adminAgent.get('/api/admin/expenses?from=2026-11-01&to=2026-11-30&q=150,000')).body.rows.length, 1);
});

test('search boxes: requests, assets, documents and the audit log', async () => {
  const ctx = await setup({ residents: 1 });
  const [res] = ctx.residents;
  await prisma.serviceRequest.createMany({ data: [
    { userId: res.id, category: 'Security', title: 'Gate light broken', description: 'Dark at night' },
    { userId: res.id, category: 'Roads', title: 'Pothole', description: 'Near plot 4' },
  ] });
  assert.deepEqual((await ctx.adminAgent.get('/api/admin/requests?q=gate')).body.rows.map((r) => r.title), ['Gate light broken']);
  assert.equal((await ctx.adminAgent.get(`/api/admin/requests?q=${res.lastName}`)).body.rows.length, 2);

  await prisma.asset.createMany({ data: [
    { name: 'Generator', category: 'EQUIPMENT', unit: 'pcs', quantity: 1, location: 'Gatehouse' },
    { name: 'Diesel', category: 'CONSUMABLE', unit: 'litres', quantity: 50 },
  ] });
  assert.deepEqual((await ctx.adminAgent.get('/api/assets?q=gatehouse')).body.rows.map((a) => a.name), ['Generator']);

  await prisma.document.create({ data: { title: 'AGM Minutes 2026', category: 'Minutes', fileName: 'x.pdf', originalName: 'agm.pdf', mimeType: 'application/pdf', sizeBytes: 1, content: Buffer.from('%PDF'), uploadedById: ctx.admin.id } });
  assert.equal((await ctx.adminAgent.get('/api/documents?q=agm')).body.rows.length, 1);
  assert.equal((await ctx.adminAgent.get('/api/documents?q=budget')).body.rows.length, 0);

  await ctx.adminAgent.post('/api/admin/expenses', { date: '2026-11-03', category: 'Security', description: 'Guards', amount: 100 });
  const audit = await ctx.adminAgent.get('/api/admin/audit?q=expense');
  assert.ok(audit.body.rows.length >= 1 && audit.body.rows.every((r) => r.action.startsWith('expense')));
  assert.equal((await ctx.adminAgent.get('/api/admin/audit?q=Ada')).body.rows.length >= 1, true, 'by who did it');
});
