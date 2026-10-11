import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import { createBinBody, idParams, listQuery, updateBinBody } from './bins.schemas';
import { createBin, getBin, listBins, updateBin } from './bins.service';

export const binsRouter = Router();
binsRouter.use(authenticate);

// Any authenticated role may read bins.
binsRouter.get('/', async (req, res) => {
  const q = listQuery.parse(req.query);
  const { rows, total } = await listBins(q);
  res.json({
    success: true,
    data: rows,
    meta: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      // For viewport queries: true means more bins match than were returned; zoom in or page.
      truncated: total > q.page * q.pageSize,
    },
  });
});

binsRouter.get('/:id', async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json({ success: true, data: await getBin(id) });
});

binsRouter.post('/', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const body = createBinBody.parse(req.body);
  res.status(201).json({ success: true, data: await createBin(body, req.user!.id, req.id) });
});

binsRouter.patch('/:id', requireRole('ADMIN', 'MANAGER'), async (req, res) => {
  const { id } = idParams.parse(req.params);
  const body = updateBinBody.parse(req.body);
  res.json({ success: true, data: await updateBin(id, body, req.user!.id, req.id) });
});
