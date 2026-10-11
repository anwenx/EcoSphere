import { Prisma, type RouteStatus, type StopStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import { raiseAlert, reconcileBinAlerts } from '../alerts/alerts.service';
import { deriveBinStatus } from '../bins/bin-rules';
import { getThresholds } from '../bins/bins.service';
import { getRoute } from '../routes/routes.service';
import type { CompleteBody, IssueBody } from './driver.schemas';

const OPEN_STOP: StopStatus[] = ['PENDING', 'ARRIVED'];
type Tx = Prisma.TransactionClient;

const navUrl = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

export async function listDriverRoutes(userId: string, includeCompleted: boolean) {
  const statuses: RouteStatus[] = includeCompleted ? ['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'] : ['PUBLISHED', 'IN_PROGRESS'];
  const rows = await prisma.route.findMany({
    where: { driverId: userId, status: { in: statuses } },
    orderBy: [{ plannedDate: 'asc' }, { code: 'asc' }],
    take: 50,
    include: { vehicle: { select: { code: true } }, stops: { select: { status: true } } },
  });
  return rows.map((r) => ({
    id: r.id, code: r.code, plannedDate: r.plannedDate.toISOString().slice(0, 10), status: r.status,
    vehicle: r.vehicle.code, totalDistanceM: r.totalDistanceM,
    progress: {
      total: r.stops.length,
      completed: r.stops.filter((s) => s.status === 'COMPLETED').length,
      remaining: r.stops.filter((s) => OPEN_STOP.includes(s.status)).length,
    },
  }));
}

/** Ownership is enforced here: a route that belongs to someone else is reported as not found. */
export async function getDriverRoute(routeId: string, userId: string) {
  const route = await getRoute(routeId);
  if (route.driver?.id !== userId || !['PUBLISHED', 'IN_PROGRESS', 'COMPLETED'].includes(route.status)) {
    throw new AppError(404, 'NOT_FOUND', 'Route not found.');
  }
  const stops = route.stops.map((s) => ({ ...s, navigationUrl: navUrl(s.lat, s.lng) }));
  const next = stops.find((s) => OPEN_STOP.includes(s.status as StopStatus)) ?? null;
  return { ...route, stops, nextStop: next };
}

interface StopCtx {
  id: string; status: StopStatus; routeId: string; binId: string; stopOrder: number;
  driverId: string | null; routeStatus: RouteStatus; vehicleId: string;
}

/** Locks the stop and its route (serializes concurrent submissions) and verifies the caller owns the route. */
async function lockStop(tx: Tx, stopId: string, userId: string): Promise<StopCtx> {
  const row = (
    await tx.$queryRaw<StopCtx[]>`
      SELECT s.id, s.status, s."routeId", s."binId", s."stopOrder", r."driverId", r.status AS "routeStatus", r."vehicleId"
      FROM "RouteStop" s JOIN "Route" r ON r.id = s."routeId"
      WHERE s.id = ${stopId} FOR UPDATE OF s, r`
  )[0];
  if (!row || row.driverId !== userId) throw new AppError(404, 'NOT_FOUND', 'Stop not found.');
  if (row.routeStatus !== 'PUBLISHED' && row.routeStatus !== 'IN_PROGRESS') {
    throw new AppError(409, 'ROUTE_NOT_ACTIVE', `Route is ${row.routeStatus}; stops cannot be changed.`);
  }
  return row;
}

async function assertNextOpenStop(tx: Tx, ctx: StopCtx) {
  const earlier = await tx.routeStop.count({
    where: { routeId: ctx.routeId, stopOrder: { lt: ctx.stopOrder }, status: { in: OPEN_STOP } },
  });
  if (earlier > 0) throw new AppError(409, 'OUT_OF_ORDER', 'Finish or skip the earlier stops first.');
}

async function startRouteIfNeeded(tx: Tx, ctx: StopCtx) {
  if (ctx.routeStatus !== 'PUBLISHED') return;
  const v = await tx.vehicle.findUnique({ where: { id: ctx.vehicleId }, select: { status: true, code: true } });
  if (!v || v.status !== 'AVAILABLE') {
    throw new AppError(409, 'VEHICLE_UNAVAILABLE', `The vehicle is ${v?.status ?? 'missing'}; the route cannot start.`);
  }
  await tx.route.update({ where: { id: ctx.routeId }, data: { status: 'IN_PROGRESS', version: { increment: 1 } } });
  await tx.vehicle.update({ where: { id: ctx.vehicleId }, data: { status: 'ON_ROUTE', version: { increment: 1 } } });
}

export async function arriveAtStop(stopId: string, userId: string, requestId: unknown) {
  const routeId = await prisma.$transaction(async (tx) => {
    const ctx = await lockStop(tx, stopId, userId);
    if (ctx.status === 'ARRIVED') return ctx.routeId; // idempotent
    if (ctx.status !== 'PENDING') throw new AppError(409, 'STOP_ALREADY_CLOSED', `Stop is already ${ctx.status}.`);
    await assertNextOpenStop(tx, ctx);
    await startRouteIfNeeded(tx, ctx);
    await tx.routeStop.update({ where: { id: stopId }, data: { status: 'ARRIVED', actualArrival: new Date() } });
    return ctx.routeId;
  });
  await audit({ actorId: userId, action: 'stop.arrive', entityType: 'RouteStop', entityId: stopId, requestId });
  return getDriverRoute(routeId, userId);
}

export async function completeStop(stopId: string, input: CompleteBody, userId: string, requestId: unknown) {
  const thresholds = await getThresholds();
  const collected = input.outcome === 'COLLECTED' || input.outcome === 'PARTIAL';
  const stopStatus: StopStatus = collected ? 'COMPLETED' : input.outcome === 'INACCESSIBLE' ? 'SKIPPED' : 'FAILED';

  const { routeId, recordId } = await prisma.$transaction(async (tx) => {
    const ctx = await lockStop(tx, stopId, userId);
    if (!OPEN_STOP.includes(ctx.status)) {
      throw new AppError(409, 'STOP_ALREADY_CLOSED', `Stop is already ${ctx.status}; duplicate submissions are rejected.`);
    }
    await assertNextOpenStop(tx, ctx);
    await startRouteIfNeeded(tx, ctx);

    const bin = await tx.bin.findUniqueOrThrow({ where: { id: ctx.binId }, select: { code: true, status: true } });
    const now = new Date();
    const fillAfter = collected ? (input.fillAfter ?? 0) : null;

    let record;
    try {
      record = await tx.collectionRecord.create({
        data: {
          binId: ctx.binId, vehicleId: ctx.vehicleId, driverId: userId, routeStopId: stopId, collectedAt: now,
          fillBefore: input.fillBefore, fillAfter, quantityLiters: input.quantityLiters ?? null,
          outcome: input.outcome, notes: input.notes ?? null,
        },
        select: { id: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'ALREADY_RECORDED', 'A collection was already recorded for this stop.');
      }
      throw err;
    }

    await tx.routeStop.update({
      where: { id: stopId },
      data: { status: stopStatus, actualArrival: now, ...(collected ? { collectedAt: now } : {}) },
    });

    if (collected) {
      const status = bin.status === 'OUT_OF_SERVICE' ? 'OUT_OF_SERVICE' : deriveBinStatus(fillAfter!, thresholds);
      await tx.bin.update({
        where: { id: ctx.binId },
        data: { fillPercent: fillAfter!, status, lastCollectedAt: now, version: { increment: 1 } },
      });
      await reconcileBinAlerts(tx, { id: ctx.binId, code: bin.code, fillPercent: fillAfter!, status }, thresholds);
    } else {
      await raiseAlert(tx, {
        type: 'FAILED_COLLECTION', severity: 'WARNING', entityType: 'Bin', entityId: ctx.binId,
        description: `Collection ${input.outcome === 'INACCESSIBLE' ? 'skipped (inaccessible)' : 'failed'} at bin ${bin.code}: ${input.notes}`,
      });
    }

    const stillOpen = await tx.routeStop.count({ where: { routeId: ctx.routeId, status: { in: OPEN_STOP } } });
    if (stillOpen === 0) {
      await tx.route.update({ where: { id: ctx.routeId }, data: { status: 'COMPLETED', version: { increment: 1 } } });
      await tx.vehicle.update({ where: { id: ctx.vehicleId }, data: { status: 'AVAILABLE', version: { increment: 1 } } });
    }
    return { routeId: ctx.routeId, recordId: record.id };
  });

  await audit({
    actorId: userId, action: 'stop.complete', entityType: 'RouteStop', entityId: stopId,
    meta: { outcome: input.outcome, collectionId: recordId }, requestId,
  });
  return { collectionId: recordId, route: await getDriverRoute(routeId, userId) };
}

export async function reportIssue(input: IssueBody, userId: string, requestId: unknown) {
  const myRoutes = await prisma.route.findMany({
    where: { driverId: userId, status: { in: ['PUBLISHED', 'IN_PROGRESS'] } },
    select: { id: true, code: true, vehicleId: true, stops: { select: { binId: true } } },
  });
  const myVehicle = await prisma.vehicle.findFirst({ where: { driverId: userId }, select: { id: true, code: true } });

  const route = input.routeId ? myRoutes.find((r) => r.id === input.routeId) : undefined;
  if (input.routeId && !route) throw new AppError(404, 'NOT_FOUND', 'Route not found.');
  if (input.binId && !myRoutes.some((r) => r.stops.some((s) => s.binId === input.binId))) {
    throw new AppError(404, 'NOT_FOUND', 'Bin is not part of any of your active routes.');
  }
  const vehicleId = input.vehicleId ?? route?.vehicleId ?? myVehicle?.id;
  if (input.vehicleId && input.vehicleId !== myVehicle?.id && !myRoutes.some((r) => r.vehicleId === input.vehicleId)) {
    throw new AppError(404, 'NOT_FOUND', 'Vehicle not found.');
  }
  if (input.type === 'INACCESSIBLE_BIN' && !input.binId) throw new AppError(400, 'VALIDATION_ERROR', 'binId is required for INACCESSIBLE_BIN.', [{ path: 'binId', message: 'Required' }]);
  if (input.type === 'VEHICLE_ISSUE' && !vehicleId) throw new AppError(422, 'NO_VEHICLE', 'No vehicle is associated with this driver.');
  if (input.type === 'BLOCKED_ROAD' && !route) throw new AppError(400, 'VALIDATION_ERROR', 'routeId is required for BLOCKED_ROAD.', [{ path: 'routeId', message: 'Required' }]);

  const issue = await prisma.$transaction(async (tx) => {
    const created = await tx.driverIssue.create({
      data: { type: input.type, driverId: userId, routeId: input.routeId, binId: input.binId, vehicleId, notes: input.notes },
    });
    if (input.type === 'VEHICLE_ISSUE') {
      await raiseAlert(tx, { type: 'VEHICLE_BREAKDOWN', severity: 'CRITICAL', entityType: 'Vehicle', entityId: vehicleId!, description: `Driver reported a vehicle issue: ${input.notes}` });
    } else if (input.type === 'INACCESSIBLE_BIN') {
      await raiseAlert(tx, { type: 'FAILED_COLLECTION', severity: 'WARNING', entityType: 'Bin', entityId: input.binId!, description: `Driver reported an inaccessible bin: ${input.notes}` });
    } else {
      await raiseAlert(tx, { type: 'DELAYED_ROUTE', severity: 'WARNING', entityType: 'Route', entityId: route!.id, description: `Driver reported a blocked road on route ${route!.code}: ${input.notes}` });
    }
    return created;
  });
  await audit({ actorId: userId, action: 'driver.issue', entityType: 'DriverIssue', entityId: issue.id, meta: { type: input.type }, requestId });
  return issue;
}
