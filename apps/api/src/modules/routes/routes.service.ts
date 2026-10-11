import { Prisma, type RouteStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { audit } from '../audit/audit.service';

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export async function listRoutes(q: {
  date?: string; status?: RouteStatus; vehicleId?: string; driverId?: string; page: number; pageSize: number;
}) {
  const where: Prisma.RouteWhereInput = {
    ...(q.date ? { plannedDate: new Date(q.date) } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}),
    ...(q.driverId ? { driverId: q.driverId } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.route.findMany({
      where, orderBy: [{ plannedDate: 'desc' }, { code: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      include: { vehicle: { select: { id: true, code: true } }, driver: { select: { id: true, name: true } }, _count: { select: { stops: true } } },
    }),
    prisma.route.count({ where }),
  ]);
  return {
    total,
    rows: rows.map((r) => ({
      id: r.id, code: r.code, plannedDate: isoDate(r.plannedDate), status: r.status, version: r.version,
      vehicle: r.vehicle, driver: r.driver, stopCount: r._count.stops, totalDistanceM: r.totalDistanceM,
      drivingSeconds: r.drivingSeconds, serviceSeconds: r.serviceSeconds, costSource: r.costSource, jobId: r.jobId,
    })),
  };
}

export async function getRoute(id: string) {
  const route = await prisma.route.findUnique({
    where: { id },
    include: {
      vehicle: { select: { id: true, code: true, type: true, capacityLiters: true } },
      driver: { select: { id: true, name: true } },
    },
  });
  if (!route) throw new AppError(404, 'NOT_FOUND', 'Route not found.');

  const [stops, depot] = await Promise.all([
    prisma.$queryRaw<
      { id: string; stopOrder: number; status: string; estimatedArrival: Date | null; serviceSeconds: number;
        expectedLiters: number | null; actualArrival: Date | null; collectedAt: Date | null;
        binId: string; binCode: string; fillPercent: number; lat: number; lng: number }[]
    >`SELECT s.id, s."stopOrder", s.status, s."estimatedArrival", s."serviceSeconds", s."expectedLiters",
             s."actualArrival", s."collectedAt", b.id AS "binId", b.code AS "binCode", b."fillPercent",
             ST_Y(b.location::geometry) AS lat, ST_X(b.location::geometry) AS lng
      FROM "RouteStop" s JOIN "Bin" b ON b.id = s."binId"
      WHERE s."routeId" = ${id} ORDER BY s."stopOrder"`,
    prisma.$queryRaw<{ id: string; name: string; lat: number; lng: number }[]>`
      SELECT id, name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM "Depot" WHERE id = ${route.depotId}`,
  ]);

  const done = stops.filter((s) => s.status === 'COMPLETED').length;
  const closed = stops.filter((s) => ['COMPLETED', 'SKIPPED', 'FAILED'].includes(s.status)).length;
  return {
    id: route.id, code: route.code, plannedDate: isoDate(route.plannedDate), status: route.status, version: route.version,
    vehicle: route.vehicle, driver: route.driver, depot: depot[0] ?? null, jobId: route.jobId,
    totalDistanceM: route.totalDistanceM, drivingSeconds: route.drivingSeconds, serviceSeconds: route.serviceSeconds,
    costSource: route.costSource, stops,
    progress: { total: stops.length, completed: done, remaining: stops.length - closed },
  };
}

/** Version-checked update; maps the one-active-route-per-vehicle/driver unique index to a clear 409. */
async function updateRouteVersioned(
  tx: Prisma.TransactionClient, id: string, version: number, data: Prisma.RouteUncheckedUpdateManyInput,
  extraWhere: Prisma.RouteWhereInput = {},
) {
  try {
    const res = await tx.route.updateMany({
      where: { id, version, ...extraWhere }, data: { ...data, version: { increment: 1 } },
    });
    if (res.count === 0) {
      const cur = await tx.route.findUnique({ where: { id }, select: { version: true, status: true } });
      if (!cur) throw new AppError(404, 'NOT_FOUND', 'Route not found.');
      if (cur.version !== version) {
        throw new AppError(409, 'STALE_VERSION', 'This route was changed by someone else. Reload and try again.', { currentVersion: cur.version });
      }
      throw new AppError(409, 'INVALID_TRANSITION', `Route is ${cur.status} and cannot be changed this way.`);
    }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'ROUTE_CONFLICT', 'This vehicle or driver already has an active route on that date.');
    }
    throw err;
  }
}

async function assertAssignableDriver(driverId: string) {
  const d = await prisma.user.findUnique({ where: { id: driverId }, select: { role: true, isActive: true } });
  if (!d || d.role !== 'DRIVER' || !d.isActive) {
    throw new AppError(422, 'INVALID_DRIVER', 'Driver does not exist, is inactive, or is not a driver.');
  }
}

export async function assignDriver(id: string, version: number, driverId: string, actorId: string, requestId: unknown) {
  await assertAssignableDriver(driverId);
  await prisma.$transaction((tx) => updateRouteVersioned(tx, id, version, { driverId }, { status: 'DRAFT' }));
  await audit({ actorId, action: 'route.assign_driver', entityType: 'Route', entityId: id, meta: { driverId }, requestId });
  return getRoute(id);
}

export async function publishRoute(id: string, version: number, actorId: string, requestId: unknown) {
  const route = await prisma.route.findUnique({
    where: { id }, include: { vehicle: { select: { status: true, code: true } }, _count: { select: { stops: true } } },
  });
  if (!route) throw new AppError(404, 'NOT_FOUND', 'Route not found.');
  if (route.status !== 'DRAFT') throw new AppError(409, 'INVALID_TRANSITION', `Route is ${route.status}; only DRAFT routes can be published.`);
  if (!route.driverId) throw new AppError(422, 'DRIVER_REQUIRED', 'Assign a driver before publishing.');
  if (route.vehicle.status !== 'AVAILABLE') {
    throw new AppError(422, 'VEHICLE_UNAVAILABLE', `Vehicle ${route.vehicle.code} is ${route.vehicle.status} and cannot be assigned.`);
  }
  if (route._count.stops === 0) throw new AppError(422, 'EMPTY_ROUTE', 'A route needs at least one stop.');
  await assertAssignableDriver(route.driverId);

  await prisma.$transaction(async (tx) => {
    await updateRouteVersioned(tx, id, version, { status: 'PUBLISHED' }, { status: 'DRAFT' });
    await tx.notification.create({
      data: {
        userId: route.driverId!, title: 'New route assigned',
        body: `Route ${route.code} is ready for ${isoDate(route.plannedDate)}.`,
      },
    });
  });
  await audit({ actorId, action: 'route.publish', entityType: 'Route', entityId: id, meta: { code: route.code }, requestId });
  return getRoute(id);
}
