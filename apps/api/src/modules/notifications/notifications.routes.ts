import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { AppError } from '../../utils/errors';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

// Always scoped to the caller; there is no way to read someone else's notifications.
notificationsRouter.get('/', async (req, res) => {
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { userId: req.user!.id, readAt: null } }),
  ]);
  res.json({ success: true, data: rows, meta: { unread } });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  const r = await prisma.notification.updateMany({ where: { id, userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
  if (r.count === 0) {
    const exists = await prisma.notification.findFirst({ where: { id, userId: req.user!.id }, select: { id: true } });
    if (!exists) throw new AppError(404, 'NOT_FOUND', 'Notification not found.');
  }
  res.json({ success: true, data: null });
});
