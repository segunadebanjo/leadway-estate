import { Router } from 'express';
import { prisma, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { hashPassword, temporaryPassword } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { sendEmail } from '../lib/messaging.js';
import { MAX_AMOUNT } from '../lib/money.js';
import { dateOnly } from '../lib/dates.js';
import { parse, paging, pageQuery, z, id, email, text, optionalText, isoDate } from '../lib/validate.js';
import { adjustCredit, memberBalance, outstandingByMember, paymentInclude } from '../services/ledger.js';
import { billMemberNow } from '../services/billing.js';

export const router = Router();

const LIST_FIELDS = {
  id: true,
  membershipId: true,
  email: true,
  role: true,
  firstName: true,
  lastName: true,
  phone: true,
  plotNumber: true,
  street: true,
  occupancyType: true,
  moveInDate: true,
  isActive: true,
  mustChangePassword: true,
  creditBalance: true,
  createdAt: true,
};

/** Search by name, email, phone, plot or membership ID ("LWE-0007", "0007" or "7"). */
export function memberSearch(q) {
  if (!q) return {};
  const term = q.trim();
  const or = [
    { firstName: { contains: term, mode: 'insensitive' } },
    { lastName: { contains: term, mode: 'insensitive' } },
    { email: { contains: term, mode: 'insensitive' } },
    { phone: { contains: term } },
    { plotNumber: { contains: term, mode: 'insensitive' } },
    { street: { contains: term, mode: 'insensitive' } },
    { membershipId: { contains: term, mode: 'insensitive' } },
  ];
  if (/^\d{1,6}$/.test(term)) or.push({ membershipId: { equals: `LWE-${term.padStart(4, '0')}` } });
  const parts = term.split(/\s+/);
  if (parts.length === 2) {
    or.push({ AND: [{ firstName: { contains: parts[0], mode: 'insensitive' } }, { lastName: { contains: parts[1], mode: 'insensitive' } }] });
  }
  return { OR: or };
}

const listQuery = pageQuery.extend({
  q: z.string().max(100).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  occupancy: z.enum(['OWNER', 'TENANT']).optional(),
  role: z.enum(['RESIDENT', 'ADMIN', 'SECURITY', 'ALL']).default('RESIDENT'),
  owing: z.enum(['true', 'false']).optional(),
});

router.get('/', async (req, res) => {
  const q = parse(listQuery, req.query);
  const where = {
    ...memberSearch(q.q),
    ...(q.status === 'all' ? {} : { isActive: q.status === 'active' }),
    ...(q.occupancy ? { occupancyType: q.occupancy } : {}),
    ...(q.role === 'ALL' ? {} : { role: q.role }),
  };
  if (q.owing === 'true') {
    const owing = await outstandingByMember();
    where.id = { in: [...owing].filter(([, v]) => v > 0).map(([k]) => k) };
  }
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: LIST_FIELDS, orderBy: [{ membershipId: 'asc' }], ...paging(q) }),
  ]);
  const owing = await outstandingByMember(rows.map((r) => r.id));
  res.json({ total, page: q.page, pageSize: q.pageSize, rows: rows.map((r) => ({ ...r, outstanding: owing.get(r.id) || 0 })) });
});

// Lightweight picker for Receive Payment / Assign fee / Broadcast.
router.get('/lookup', async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).default('') }), req.query);
  const rows = await prisma.user.findMany({
    where: { role: 'RESIDENT', ...memberSearch(q.q) },
    select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, street: true, isActive: true, creditBalance: true, email: true, phone: true },
    orderBy: { membershipId: 'asc' },
    take: 20,
  });
  const owing = await outstandingByMember(rows.map((r) => r.id));
  res.json({ rows: rows.map((r) => ({ ...r, outstanding: owing.get(r.id) || 0 })) });
});

router.get('/:id', async (req, res) => {
  const userId = parse(id, req.params.id);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: LIST_FIELDS });
  if (!user) throw notFound('Member not found');
  const [balance, invoices, payments, credits] = await Promise.all([
    memberBalance(userId),
    prisma.invoice.findMany({ where: { userId }, orderBy: [{ dueDate: 'desc' }, { id: 'desc' }], include: { feeType: { select: { name: true } } } }),
    prisma.payment.findMany({ where: { userId }, orderBy: { paidAt: 'desc' }, include: paymentInclude }),
    prisma.creditEntry.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } }),
  ]);
  res.json({ user, balance, invoices, payments, credits });
});

const memberBody = z.object({
  firstName: text(80),
  lastName: text(80),
  email,
  phone: optionalText(30),
  plotNumber: optionalText(40),
  street: optionalText(120),
  occupancyType: z.enum(['OWNER', 'TENANT']).default('OWNER'),
  role: z.enum(['RESIDENT', 'ADMIN', 'SECURITY']).default('RESIDENT'),
  moveInDate: isoDate.optional().nullable(),
});

async function issueTemporaryPassword(user, sendIt, reason) {
  const password = temporaryPassword();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(password), mustChangePassword: true, tokenVersion: { increment: 1 } },
  });
  let emailed = false;
  if (sendIt) {
    emailed = await sendEmail({
      to: user.email,
      subject: `${config.estateName}: your sign-in details`,
      text: `Dear ${user.firstName},\n\n${reason}\n\nSign in at ${config.appUrl}\nEmail: ${user.email}\nTemporary password: ${password}\n\nYou will be asked to choose your own password when you sign in.\n\n${config.estateName}`,
    });
  }
  return { temporaryPassword: password, emailed };
}

router.post('/', async (req, res) => {
  const body = parse(memberBody.extend({ sendEmail: z.boolean().default(false) }), req.body);
  let user;
  try {
    user = await prisma.user.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        plotNumber: body.plotNumber,
        street: body.street,
        occupancyType: body.occupancyType,
        role: body.role,
        moveInDate: body.moveInDate ? dateOnly(body.moveInDate) : null,
        passwordHash: '!',
      },
      select: LIST_FIELDS,
    });
  } catch (err) {
    if (isUniqueViolation(err, 'email')) throw conflict('A member with that email already exists');
    throw err;
  }
  const creds = await issueTemporaryPassword(user, body.sendEmail, `An account has been created for you on the ${config.estateName} residents' portal.`);
  const invoicesCreated = user.role === 'RESIDENT' ? await billMemberNow(user.id) : 0;
  await audit(req, 'member.create', 'User', user.id, { membershipId: user.membershipId, role: user.role });
  res.status(201).json({ user, ...creds, invoicesCreated });
});

router.patch('/:id', async (req, res) => {
  const userId = parse(id, req.params.id);
  const body = parse(memberBody.partial(), req.body);
  const before = await prisma.user.findUnique({ where: { id: userId }, select: LIST_FIELDS });
  if (!before) throw notFound('Member not found');
  if (userId === req.user.id && body.role && body.role !== 'ADMIN') throw badRequest('You cannot remove your own admin role');
  const data = { ...body };
  if ('moveInDate' in body) data.moveInDate = body.moveInDate ? dateOnly(body.moveInDate) : null;
  let user;
  try {
    user = await prisma.user.update({ where: { id: userId }, data, select: LIST_FIELDS });
  } catch (err) {
    if (isUniqueViolation(err, 'email')) throw conflict('A member with that email already exists');
    throw err;
  }
  const changes = {};
  for (const k of Object.keys(body)) if (String(before[k] ?? '') !== String(user[k] ?? '')) changes[k] = { from: before[k], to: user[k] };
  await audit(req, 'member.update', 'User', userId, changes);
  res.json({ user });
});

router.post('/:id/deactivate', async (req, res) => {
  const userId = parse(id, req.params.id);
  if (userId === req.user.id) throw badRequest('You cannot deactivate your own account');
  const user = await prisma.user.update({ where: { id: userId }, data: { isActive: false, tokenVersion: { increment: 1 } }, select: LIST_FIELDS }).catch(() => null);
  if (!user) throw notFound('Member not found');
  await audit(req, 'member.deactivate', 'User', userId);
  res.json({ user });
});

router.post('/:id/reactivate', async (req, res) => {
  const userId = parse(id, req.params.id);
  const user = await prisma.user.update({ where: { id: userId }, data: { isActive: true }, select: LIST_FIELDS }).catch(() => null);
  if (!user) throw notFound('Member not found');
  const invoicesCreated = user.role === 'RESIDENT' ? await billMemberNow(user.id) : 0;
  await audit(req, 'member.reactivate', 'User', userId);
  res.json({ user, invoicesCreated });
});

router.post('/:id/reset-password', async (req, res) => {
  const userId = parse(id, req.params.id);
  const body = parse(z.object({ sendEmail: z.boolean().default(false) }), req.body ?? {});
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Member not found');
  const creds = await issueTemporaryPassword(user, body.sendEmail, 'Your password has been reset by the estate office.');
  await audit(req, 'member.reset_password', 'User', userId, { emailed: creds.emailed });
  res.json(creds);
});

router.post('/:id/credit-adjustment', async (req, res) => {
  const userId = parse(id, req.params.id);
  const body = parse(
    z.object({
      amount: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= MAX_AMOUNT, 'must be a non-zero amount in kobo'),
      note: text(300),
    }),
    req.body,
  );
  const result = await adjustCredit(userId, body.amount, body.note);
  await audit(req, 'member.credit_adjustment', 'User', userId, body);
  res.json(result);
});
