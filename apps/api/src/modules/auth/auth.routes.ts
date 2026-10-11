import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { hash, verify } from 'argon2';
import { z } from 'zod';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { AppError } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import { CSRF_COOKIE, clearSession, issueSession } from './session';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  handler: (_req, _res, next) =>
    next(new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Try again later.')),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});

// Verified against when the email is unknown, so response time does not reveal which emails exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hash(randomBytes(16).toString('hex')));

export const authRouter = Router();

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = await verify(user?.passwordHash ?? (await getDummyHash()), password).catch(() => false);

  if (!user || !user.isActive || !passwordOk) {
    await audit({ action: 'auth.login_failed', entityType: 'User', meta: { email }, requestId: req.id });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }

  const csrfToken = issueSession(res, user);
  await audit({ actorId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, requestId: req.id });
  res.json({
    success: true,
    data: { user: { id: user.id, name: user.name, email: user.email, role: user.role }, csrfToken },
  });
});

authRouter.post('/logout', authenticate, async (req, res) => {
  // Clears this browser's cookies. Revoking *all* sessions = bump user.tokenVersion (admin action, later slice).
  clearSession(res);
  await audit({ actorId: req.user!.id, action: 'auth.logout', entityType: 'User', entityId: req.user!.id, requestId: req.id });
  res.json({ success: true, data: null });
});

authRouter.get('/me', authenticate, (req, res) => {
  const csrfToken = typeof req.cookies?.[CSRF_COOKIE] === 'string' ? req.cookies[CSRF_COOKIE] : null;
  res.json({ success: true, data: { user: req.user, csrfToken } });
});
