import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';

export const usersRouter = Router();

// ADMIN only. Explicit select: password hashes are never returned.
usersRouter.get('/', authenticate, requireRole('ADMIN'), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  res.json({ success: true, data: users, meta: { count: users.length } });
});
