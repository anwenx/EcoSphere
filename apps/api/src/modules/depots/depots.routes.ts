import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';

export const depotsRouter = Router();
depotsRouter.use(authenticate);

depotsRouter.get('/', async (_req, res) => {
  const depots = await prisma.$queryRaw<
    { id: string; name: string; opensAt: string; closesAt: string; isActive: boolean; lat: number; lng: number }[]
  >`
    SELECT id, name, "opensAt", "closesAt", "isActive",
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
    FROM "Depot" ORDER BY name`;
  res.json({ success: true, data: depots });
});
