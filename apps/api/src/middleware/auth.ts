import type { RequestHandler } from 'express';
import type { Role } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma';
import { CSRF_COOKIE, SESSION_COOKIE, readSession } from '../modules/auth/session';
import { AppError, forbidden, unauthorized } from '../utils/errors';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Resolves the session cookie to a live, active user on every request (so revocation is immediate). */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string') return next(unauthorized());
  const claims = readSession(token);
  if (!claims) return next(unauthorized());

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, name: true, email: true, role: true, isActive: true, tokenVersion: true },
  });
  if (!user || !user.isActive || user.tokenVersion !== claims.tv) return next(unauthorized());

  req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  next();
};

/** Server-side RBAC. Must run after `authenticate`. */
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Double-submit CSRF check for cookie sessions. Login is exempt (no session exists yet; it is rate limited). */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method) || req.path === '/auth/login') return next();
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  if (typeof cookie !== 'string' || !header) {
    return next(new AppError(403, 'CSRF_FAILED', 'Missing CSRF token.'));
  }
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return next(new AppError(403, 'CSRF_FAILED', 'Invalid CSRF token.'));
  }
  next();
};
