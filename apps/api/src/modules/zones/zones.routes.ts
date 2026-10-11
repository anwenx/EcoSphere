import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth';
import { getThresholds } from '../bins/bins.service';

export const zonesRouter = Router();
zonesRouter.use(authenticate);

interface ZoneRow {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  boundary: unknown;
  binCount: number;
  criticalCount: number;
}

// Boundary is returned as GeoJSON (WGS84) ready for a MapLibre source. Out-of-service bins are excluded from counts.
zonesRouter.get('/', async (_req, res) => {
  const { criticalPercent } = await getThresholds();
  const zones = await prisma.$queryRaw<ZoneRow[]>`
    SELECT z.id, z.name, z.code, z."isActive",
           ST_AsGeoJSON(z.boundary::geometry)::json AS boundary,
           COUNT(b.id)::int AS "binCount",
           COUNT(b.id) FILTER (WHERE b."fillPercent" >= ${criticalPercent}::int)::int AS "criticalCount"
    FROM "Zone" z
    LEFT JOIN "Bin" b ON b."zoneId" = z.id AND b.status <> 'OUT_OF_SERVICE'
    GROUP BY z.id
    ORDER BY z.code`;
  res.json({ success: true, data: zones, meta: { criticalPercent } });
});
