import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type { Role } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export const SESSION_COOKIE = 'eco_session';
export const CSRF_COOKIE = 'eco_csrf';

export interface SessionClaims {
  sub: string;
  role: Role;
  tv: number; // user.tokenVersion at issue time; bumping it revokes the session
}

export function issueSession(res: Response, user: { id: string; role: Role; tokenVersion: number }): string {
  const ttlSeconds = env.SESSION_TTL_HOURS * 3600;
  const token = jwt.sign({ role: user.role, tv: user.tokenVersion }, env.JWT_SECRET, {
    subject: user.id,
    algorithm: 'HS256',
    expiresIn: ttlSeconds,
  });
  const csrf = randomBytes(32).toString('hex');
  const base = {
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ttlSeconds * 1000,
  };
  res.cookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  res.cookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
  return csrf;
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

export function readSession(token: string): SessionClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub) return null;
    return payload as unknown as SessionClaims;
  } catch {
    return null;
  }
}
