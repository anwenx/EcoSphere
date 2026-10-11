import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { completeBody, idParams, issueBody, listQuery } from './driver.schemas';
import { arriveAtStop, completeStop, getDriverRoute, listDriverRoutes, reportIssue } from './driver.service';

export const driverRouter = Router();
driverRouter.use(authenticate, requireRole('DRIVER'));

driverRouter.get('/routes', async (req, res) => {
  const q = listQuery.parse(req.query);
  res.json({ success: true, data: await listDriverRoutes(req.user!.id, q.includeCompleted) });
});

driverRouter.get('/routes/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ success: true, data: await getDriverRoute(id, req.user!.id) });
});

driverRouter.post('/stops/:id/arrive', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ success: true, data: await arriveAtStop(id, req.user!.id, req.id) });
});

driverRouter.post('/stops/:id/complete', async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = completeBody.parse(req.body);
  res.status(201).json({ success: true, data: await completeStop(id, body, req.user!.id, req.id) });
});

driverRouter.post('/issues', async (req, res) => {
  const body = issueBody.parse(req.body);
  res.status(201).json({ success: true, data: await reportIssue(body, req.user!.id, req.id) });
});
