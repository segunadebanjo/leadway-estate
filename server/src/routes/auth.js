import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { config } from '../config.js';
import {
  COOKIE_NAME,
  cookieOptions,
  hashPassword,
  passwordProblem,
  randomToken,
  sha256,
  signSession,
  verifyPassword,
} from '../lib/auth.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { sendEmail } from '../lib/messaging.js';
import { parse, z, email } from '../lib/validate.js';

export const router = Router();

const limiter = (max) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.isTest ? 1000 : max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
  });

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, tokenVersion, ...rest } = u;
  return rest;
}

// A real hash, so an unknown email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

router.post('/login', limiter(10), async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  const ok = await verifyPassword(body.password, user?.passwordHash || DUMMY_HASH);
  if (!user || !ok) throw unauthorized('Email or password is incorrect');
  if (!user.isActive) throw unauthorized('This account has been deactivated. Please contact the estate office.');
  res.cookie(COOKIE_NAME, signSession(user), cookieOptions());
  res.json({ user: publicUser(user) });
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) throw unauthorized();
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', limiter(20), async (req, res) => {
  if (!req.user) throw unauthorized();
  const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }), req.body);
  const problem = passwordProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect');
  if (body.currentPassword === body.newPassword) throw badRequest('Choose a password different from the current one');
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false, tokenVersion: { increment: 1 } },
  });
  res.cookie(COOKIE_NAME, signSession(updated), cookieOptions());
  res.json({ user: publicUser(updated) });
});

// Self-service reset: same answer for every input; one-hour single-use link;
// only a hash of the token is stored; a reset signs the user out everywhere.
router.post('/forgot-password', limiter(5), async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.isActive) {
    const token = randomToken();
    await prisma.$transaction([
      prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } }),
    ]);
    const link = `${config.appUrl}/reset-password?token=${token}`;
    await sendEmail({
      to: user.email,
      subject: `${config.estateName}: reset your password`,
      text: `Dear ${user.firstName},\n\nUse this link within one hour to choose a new password:\n${link}\n\nIf you did not ask for this, ignore this email; your password is unchanged.\n\n${config.estateName}`,
    });
  }
  res.json({ ok: true, message: 'If that email belongs to an account, a reset link is on its way.' });
});

router.post('/reset-password', limiter(10), async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20).max(200), newPassword: z.string().max(200) }), req.body);
  const problem = passwordProblem(body.newPassword);
  if (problem) throw badRequest(problem);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(body.token) }, include: { user: true } });
  if (!record || record.usedAt || record.expiresAt < new Date() || !record.user.isActive) {
    throw badRequest('This reset link is invalid or has expired. Please request a new one.');
  }
  const claimed = await prisma.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw badRequest('This reset link has already been used.');
  await prisma.user.update({
    where: { id: record.userId },
    data: { passwordHash: await hashPassword(body.newPassword), mustChangePassword: false, tokenVersion: { increment: 1 } },
  });
  res.json({ ok: true });
});
