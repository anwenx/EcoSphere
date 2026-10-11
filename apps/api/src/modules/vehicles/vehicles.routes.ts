import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { authenticate, requireRole } from '../../middleware/auth';

export const vehiclesRouter = Router();
vehiclesRouter.use(authenticate, requireRole('ADMIN', 'MANAGER'));

interface VehicleRow {
  id: string; code: string; type: string; capacityLiters: number; maxStops: number | null; status: string;
  maintenanceNote: string | null; fuelKmPerLiter: number | null; driverId: string | null; driverName: string | null;
  locationAt: Date | null; locationOrigin: string; origin: string; version: number; lat: number | null; lng: number | null;
}

// Read-only for now. `locationOrigin` says whether a position is real, demo, or simulated; never treat DEMO/SIMULATED as live GPS.
vehiclesRouter.get('/', async (_req, res) => {
  const rows = await prisma.$queryRaw<VehicleRow[]>`
    SELECT v.id, v.code, v.type, v."capacityLiters", v."maxStops", v.status, v."maintenanceNote",
           v."fuelKmPerLiter"::float8 AS "fuelKmPerLiter", v."driverId", u.name AS "driverName",
           v."locationAt", v."locationOrigin"::text AS "locationOrigin", v.origin::text AS origin, v.version,
           ST_Y(v.location::geometry) AS lat, ST_X(v.location::geometry) AS lng
    FROM "Vehicle" v LEFT JOIN "User" u ON u.id = v."driverId"
    ORDER BY v.code`;
  res.json({ success: true, data: rows, meta: { count: rows.length } });
});
