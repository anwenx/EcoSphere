import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth';
import {
  assignDriverBody,
  idParams,
  listQuery,
  publishBody,
} from './routes.schemas';
import {
  assignDriver,
  getRoute,
  listRoutes,
  publishRoute,
} from './routes.service';

export const routesRouter = Router();

// Only authenticated admins and managers can access planner routes.
routesRouter.use(authenticate, requireRole('ADMIN', 'MANAGER'));

// GET /routes?page=1&pageSize=50
routesRouter.get('/', async (req, res, next) => {
  try {
    const q = listQuery.parse(req.query);
    const { rows, total } = await listRoutes(q);

    res.json({
      success: true,
      data: rows,
      meta: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /routes/:id
routesRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = idParams.parse(req.params);
    const route = await getRoute(id);

    res.json({
      success: true,
      data: route,
    });
  } catch (error) {
    next(error);
  }
});

// POST /routes/:id/assign-driver
routesRouter.post('/:id/assign-driver', async (req, res, next) => {
  try {
    const { id } = idParams.parse(req.params);
    const body = assignDriverBody.parse(req.body);

    const route = await assignDriver(
      id,
      body.version,
      body.driverId,
      req.user!.id,
      req.id,
    );

    res.json({
      success: true,
      data: route,
    });
  } catch (error) {
    next(error);
  }
});

// POST /routes/:id/publish
routesRouter.post('/:id/publish', async (req, res, next) => {
  try {
    const { id } = idParams.parse(req.params);
    const body = publishBody.parse(req.body);

    const route = await publishRoute(
      id,
      body.version,
      req.user!.id,
      req.id,
    );

    res.json({
      success: true,
      data: route,
    });
  } catch (error) {
    next(error);
  }
});

export default routesRouter;