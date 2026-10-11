import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import { getActivity, getSummary, getTopAlerts, resolvePeriod } from './dashboard.service';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate, requireRole('ADMIN', 'MANAGER'));

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

dashboardRouter.get('/summary', async (req, res) => {
  const q = z.object({ from: date.optional(), to: date.optional(), zoneId: z.string().uuid().optional() }).parse(req.query);
  res.json({ success: true, data: await getSummary(resolvePeriod(q.from, q.to), q.zoneId) });
});

dashboardRouter.get('/activity', async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
  res.json({ success: true, data: await getActivity(limit) });
});

dashboardRouter.get('/alerts', async (req, res) => {
  const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query);
  res.json({ success: true, data: await getTopAlerts(limit) });
});
