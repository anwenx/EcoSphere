import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { assignDriverBody, idParams, listQuery, publishBody } from './routes.schemas';
import { assignDriver, getRoute, listRoutes, publishRoute } from './routes.service';

export const routesRouter = Router();
// Drivers get their own ownership-checked endpoints (/driver/*); this surface is for planners.
routesRouter.use(authenticate, requireRole('ADMIN', 'MANAGER'));

routesRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const { rows, total } = await listRoutes(q);
  res.json({ success: true, data: rows, meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) } });
});

routesRouter.get('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ success: true, data: await getRoute(id) });
});

routesRouter.post('/:id/assign-driver', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = assignDriverBody.parse(req.body);
  res.json({ success: true, data: await assignDriver(id, body.version, body.driverId, req.user!.id, req.id) });
});

routesRouter.post('/:id/publish', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = publishBody.parse(req.body);
  res.json({ success: true, data: await publishRoute(id, body.version, req.user!.id, req.id) });
});
