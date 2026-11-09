import { Router } from 'express';
import { prisma, isUniqueViolation } from '../db.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { sendCsv } from '../lib/csv.js';
import { runLimited, sendEmail } from '../lib/messaging.js';
import { todayIso } from '../lib/dates.js';
import { id, optionalText, parse, text, z } from '../lib/validate.js';
import { requireAdmin, requireAuth, requireResident } from '../middleware/auth.js';

// Polls (one vote per member, results shown when the poll closes) and
// meetings with an attendance register.
export const router = Router();
router.use(requireAuth);

const audienceWhere = (audience) => ({
  role: 'RESIDENT',
  isActive: true,
  ...(audience === 'OWNERS' ? { occupancyType: 'OWNER' } : audience === 'TENANTS' ? { occupancyType: 'TENANT' } : {}),
});
const eligible = (poll, user) => user.role === 'RESIDENT' && (poll.audience === 'ALL' || (poll.audience === 'OWNERS' ? user.occupancyType === 'OWNER' : user.occupancyType === 'TENANT'));
const isOpen = (poll) => !poll.closedAt && poll.closesAt > new Date();

async function tell(where, { title, body, link, email }) {
  const users = await prisma.user.findMany({ where, select: { id: true, email: true, firstName: true } });
  if (!users.length) return 0;
  await prisma.notification.createMany({ data: users.map((u) => ({ userId: u.id, title, body, link })) });
  if (email) await runLimited(users, 5, (u) => sendEmail({ to: u.email, subject: `${config.estateName}: ${title}`, text: `Dear ${u.firstName},\n\n${body}\n\n${config.appUrl}${link}\n\n${config.estateName}` }));
  return users.length;
}

// ---- Polls -------------------------------------------------------------------

async function pollView(poll, user) {
  const admin = user.role === 'ADMIN';
  const [counts, mine, electorate] = await Promise.all([
    prisma.pollVote.groupBy({ by: ['optionId'], where: { pollId: poll.id }, _count: true }),
    user.role === 'RESIDENT' ? prisma.pollVote.findUnique({ where: { pollId_userId: { pollId: poll.id, userId: user.id } } }) : null,
    prisma.user.count({ where: audienceWhere(poll.audience) }),
  ]);
  const open = isOpen(poll);
  const showResults = admin || !open;
  const byOption = new Map(counts.map((c) => [c.optionId, c._count]));
  const votes = counts.reduce((s, c) => s + c._count, 0);
  return {
    id: poll.id,
    title: poll.title,
    description: poll.description,
    audience: poll.audience,
    closesAt: poll.closesAt,
    closedAt: poll.closedAt,
    createdAt: poll.createdAt,
    open,
    canVote: open && !mine && eligible(poll, user),
    myOptionId: mine?.optionId ?? null,
    votes: showResults ? votes : null,
    electorate: showResults ? electorate : null,
    options: poll.options.map((o) => ({ id: o.id, label: o.label, votes: showResults ? byOption.get(o.id) || 0 : null })),
  };
}

router.get('/polls', async (req, res) => {
  const where = req.user.role === 'ADMIN' ? {} : { audience: { in: ['ALL', req.user.occupancyType === 'TENANT' ? 'TENANTS' : 'OWNERS'] } };
  if (req.user.role === 'SECURITY') throw forbidden();
  const polls = await prisma.poll.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { options: { orderBy: { position: 'asc' } } } });
  const rows = [];
  for (const p of polls) rows.push(await pollView(p, req.user));
  res.json({ rows });
});

router.post('/polls', requireAdmin, async (req, res) => {
  const body = parse(
    z.object({
      title: text(200),
      description: optionalText(2000),
      audience: z.enum(['ALL', 'OWNERS', 'TENANTS']).default('ALL'),
      closesOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date'),
      options: z.array(z.string().trim().min(1).max(200)).min(2, 'Give at least 2 choices').max(10, 'At most 10 choices'),
      email: z.boolean().default(false),
    }),
    req.body,
  );
  if (body.closesOn < todayIso()) throw badRequest('The closing date cannot be in the past');
  if (new Set(body.options.map((o) => o.toLowerCase())).size !== body.options.length) throw badRequest('Each choice must be different');
  // Voting closes at the end of the closing day, Lagos time (UTC+1).
  const closesAt = new Date(`${body.closesOn}T23:59:59.000+01:00`);
  const poll = await prisma.poll.create({
    data: { title: body.title, description: body.description, audience: body.audience, closesAt, createdById: req.user.id, options: { create: body.options.map((label, i) => ({ label, position: i })) } },
    include: { options: { orderBy: { position: 'asc' } } },
  });
  const told = await tell(audienceWhere(body.audience), { title: `New poll: ${poll.title}`, body: `Please vote by ${body.closesOn}. ${poll.description || ''}`.trim(), link: '/community', email: body.email });
  await audit(req, 'poll.create', 'Poll', poll.id, { title: poll.title, audience: poll.audience, closesOn: body.closesOn, notified: told });
  res.status(201).json(await pollView(poll, req.user));
});

router.post('/polls/:id/vote', requireResident, async (req, res) => {
  const pollId = parse(id, req.params.id);
  const body = parse(z.object({ optionId: id }), req.body);
  const poll = await prisma.poll.findUnique({ where: { id: pollId }, include: { options: { orderBy: { position: 'asc' } } } });
  if (!poll) throw notFound('Poll not found');
  if (!eligible(poll, req.user)) throw forbidden('This poll is not open to you');
  if (!isOpen(poll)) throw badRequest('Voting on this poll has closed');
  if (!poll.options.some((o) => o.id === body.optionId)) throw badRequest('That is not one of the choices');
  try {
    await prisma.pollVote.create({ data: { pollId, optionId: body.optionId, userId: req.user.id } });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('You have already voted on this poll');
    throw err;
  }
  res.json(await pollView(poll, req.user));
});

router.post('/polls/:id/close', requireAdmin, async (req, res) => {
  const pollId = parse(id, req.params.id);
  const poll = await prisma.poll.findUnique({ where: { id: pollId } });
  if (!poll) throw notFound('Poll not found');
  if (!isOpen(poll)) throw badRequest('This poll is already closed');
  const closed = await prisma.poll.update({ where: { id: pollId }, data: { closedAt: new Date() }, include: { options: { orderBy: { position: 'asc' } } } });
  await tell(audienceWhere(poll.audience), { title: `Poll closed: ${poll.title}`, body: 'Voting has closed. See the results in the app.', link: '/community' });
  await audit(req, 'poll.close', 'Poll', pollId);
  res.json(await pollView(closed, req.user));
});

// ---- Meetings ------------------------------------------------------------------

router.get('/meetings', async (req, res) => {
  if (req.user.role === 'SECURITY') throw forbidden();
  const meetings = await prisma.meeting.findMany({ orderBy: { startsAt: 'desc' }, take: 100, include: { _count: { select: { attendance: true } } } });
  const mine = req.user.role === 'RESIDENT'
    ? new Set((await prisma.meetingAttendance.findMany({ where: { userId: req.user.id }, select: { meetingId: true } })).map((a) => a.meetingId))
    : null;
  res.json({
    rows: meetings.map(({ _count, ...m }) => ({ ...m, attended: _count.attendance, ...(mine ? { iAttended: mine.has(m.id) } : {}) })),
  });
});

const meetingBody = z.object({
  title: text(200),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'must be a date and time'),
  location: optionalText(200),
  agenda: optionalText(5000),
});

router.post('/meetings', requireAdmin, async (req, res) => {
  const body = parse(meetingBody.extend({ notify: z.boolean().default(true), email: z.boolean().default(false) }), req.body);
  const startsAt = new Date(`${body.startsAt}:00.000+01:00`); // entered in Lagos time
  const meeting = await prisma.meeting.create({ data: { title: body.title, startsAt, location: body.location, agenda: body.agenda, createdById: req.user.id } });
  if (body.notify) {
    const when = startsAt.toLocaleString('en-NG', { timeZone: config.timezone, dateStyle: 'full', timeStyle: 'short' });
    await tell(audienceWhere('ALL'), { title: `Meeting: ${meeting.title}`, body: `${when}${meeting.location ? ` at ${meeting.location}` : ''}.${meeting.agenda ? `\n\nAgenda:\n${meeting.agenda}` : ''}`, link: '/community', email: body.email });
  }
  await audit(req, 'meeting.create', 'Meeting', meeting.id, { title: meeting.title, startsAt: body.startsAt });
  res.status(201).json(meeting);
});

/** The register: every active resident, marked present or not. */
async function register(meetingId) {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting) throw notFound('Meeting not found');
  const [members, marks] = await Promise.all([
    prisma.user.findMany({ where: { role: 'RESIDENT', OR: [{ isActive: true }, { attendance: { some: { meetingId } } }] }, orderBy: { membershipId: 'asc' }, select: { id: true, membershipId: true, firstName: true, lastName: true, plotNumber: true, street: true, occupancyType: true, isActive: true } }),
    prisma.meetingAttendance.findMany({ where: { meetingId } }),
  ]);
  const byUser = new Map(marks.map((m) => [m.userId, m]));
  const rows = members.map((u) => ({ ...u, present: byUser.has(u.id), proxyName: byUser.get(u.id)?.proxyName || null }));
  const eligibleCount = members.filter((m) => m.isActive).length;
  return { meeting, rows, present: marks.length, eligible: eligibleCount, turnout: eligibleCount ? Math.round((marks.length / eligibleCount) * 1000) / 10 : 0 };
}

router.get('/meetings/:id', requireAdmin, async (req, res) => {
  res.json(await register(parse(id, req.params.id)));
});

router.get('/meetings/:id/register.csv', requireAdmin, async (req, res) => {
  const r = await register(parse(id, req.params.id));
  sendCsv(res, `attendance_${r.meeting.startsAt.toISOString().slice(0, 10)}.csv`, [
    { key: 'membershipId', label: 'Membership ID' },
    { key: 'name', label: 'Name', map: (x) => `${x.firstName} ${x.lastName}` },
    { key: 'plot', label: 'Plot / street', map: (x) => [x.plotNumber, x.street].filter(Boolean).join(', ') },
    { key: 'occupancyType', label: 'Occupancy' },
    { key: 'present', label: 'Present', map: (x) => (x.present ? 'YES' : '') },
    { key: 'proxyName', label: 'Represented by (proxy)' },
  ], r.rows);
});

router.post('/meetings/:id/attendance', requireAdmin, async (req, res) => {
  const meetingId = parse(id, req.params.id);
  const body = parse(z.object({ userId: id, present: z.boolean(), proxyName: optionalText(120) }), req.body);
  if (!(await prisma.meeting.findUnique({ where: { id: meetingId } }))) throw notFound('Meeting not found');
  if (body.present) {
    await prisma.meetingAttendance.upsert({
      where: { meetingId_userId: { meetingId, userId: body.userId } },
      create: { meetingId, userId: body.userId, proxyName: body.proxyName },
      update: { proxyName: body.proxyName },
    });
  } else {
    await prisma.meetingAttendance.deleteMany({ where: { meetingId, userId: body.userId } });
  }
  const r = await register(meetingId);
  res.json({ present: r.present, eligible: r.eligible, turnout: r.turnout });
});
