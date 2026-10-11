import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { createJobBody, jobIdParams, savePlanBody } from './optimization.schemas';
import { createJob, getJob, getJobResult, savePlan } from './optimization.service';

export const optimizationRouter = Router();
optimizationRouter.use(authenticate, requireRole('ADMIN', 'MANAGER'));

optimizationRouter.post('/jobs', async (req, res) => {
  const body = createJobBody.parse(req.body);
  res.status(202).json({ success: true, data: await createJob(body, req.user!.id, req.id) });
});

optimizationRouter.get('/jobs/:id', async (req, res) => {
  const { id } = jobIdParams.parse(req.params);
  res.json({ success: true, data: await getJob(id) });
});

optimizationRouter.get('/jobs/:id/result', async (req, res) => {
  const { id } = jobIdParams.parse(req.params);
  res.json({ success: true, data: await getJobResult(id) });
});

optimizationRouter.post('/jobs/:id/plan', async (req, res) => {
  const { id } = jobIdParams.parse(req.params);
  const body = savePlanBody.parse(req.body ?? {});
  res.status(201).json({ success: true, data: await savePlan(id, body, req.user!.id, req.id) });
});
