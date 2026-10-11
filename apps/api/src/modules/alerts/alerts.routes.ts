import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import { acknowledgeAlert, assignAlert, dismissAlert, listAlerts, resolveAlert } from './alerts.service';

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  type: z.enum(['CRITICAL_FILL', 'OVERFLOW', 'FAILED_COLLECTION', 'DELAYED_ROUTE', 'VEHICLE_BREAKDOWN',
    'UNASSIGNED_CRITICAL_BIN', 'OPTIMIZATION_FAILURE', 'STALE_VEHICLE_POSITION']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const alertsRouter = Router();
alertsRouter.use(authenticate, requireRole('ADMIN', 'MANAGER'));

alertsRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const { rows, total } = await listAlerts(q);
  res.json({ success: true, data: rows, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) } });
});

alertsRouter.post('/:id/acknowledge', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ success: true, data: await acknowledgeAlert(id, req.user!.id, req.id) });
});

alertsRouter.post('/:id/assign', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  res.json({ success: true, data: await assignAlert(id, userId, req.user!.id, req.id) });
});

alertsRouter.post('/:id/resolve', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { resolution } = z.object({ resolution: z.string().trim().min(3).max(500) }).parse(req.body);
  res.json({ success: true, data: await resolveAlert(id, resolution, req.user!.id, req.id) });
});

alertsRouter.post('/:id/dismiss', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { reason } = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  res.json({ success: true, data: await dismissAlert(id, reason, req.user!, req.id) });
});
