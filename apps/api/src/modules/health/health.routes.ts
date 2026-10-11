import { Router } from 'express';
import { prisma } from '../../lib/prisma';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ success: true, data: { status: 'ok', database: 'up' } });
  } catch {
    res.status(503).json({ success: false, error: { code: 'DB_UNAVAILABLE', message: 'Database is unreachable.', details: [] } });
  }
});
