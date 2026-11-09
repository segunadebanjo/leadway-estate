import { prisma } from '../db.js';
import { COOKIE_NAME, verifySession } from '../lib/auth.js';
import { forbidden, unauthorized } from '../lib/errors.js';

const USER_FIELDS = {
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
  isActive: true,
  mustChangePassword: true,
  creditBalance: true,
  tokenVersion: true,
};

/**
 * Loads the signed-in user from the database on every request, so a
 * deactivation, role change or password reset takes effect immediately.
 */
export async function loadUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();
  const claims = verifySession(token);
  if (!claims) return next();
  const user = await prisma.user.findUnique({ where: { id: Number(claims.sub) }, select: USER_FIELDS });
  if (user && user.isActive && user.tokenVersion === claims.v) req.user = user;
  next();
}

/** Signed in and, unless `allowPasswordChange`, past the forced password change. */
export function requireAuth(req, _res, next) {
  if (!req.user) throw unauthorized();
  if (req.user.mustChangePassword) throw forbidden('You must choose a new password before continuing');
  next();
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (req.user.mustChangePassword) throw forbidden('You must choose a new password before continuing');
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };

export const requireAdmin = requireRole('ADMIN');
export const requireResident = requireRole('RESIDENT');

/**
 * CSRF defence for a cookie-authenticated JSON API: every state-changing request
 * must carry a custom header, which a cross-site form or image cannot send
 * (and a cross-site fetch cannot send without a CORS preflight we never grant).
 */
export function csrfHeader(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'fetch') throw forbidden('Missing request header');
  next();
}
