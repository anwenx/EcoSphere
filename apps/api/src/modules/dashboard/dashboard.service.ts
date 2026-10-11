import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { getThresholds } from '../bins/bins.service';

export interface Period { from: string; to: string }

export function resolvePeriod(from?: string, to?: string): Period {
  const end = to ?? new Date().toISOString().slice(0, 10);
  const start = from ?? new Date(Date.parse(end) - 6 * 86_400_000).toISOString().slice(0, 10);
  const span = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (Number.isNaN(span) || span < 0 || span > 366) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid period: from must be <= to and the range at most 366 days.');
  }
  return { from: start, to: end };
}

const n = (v: unknown) => Number(v ?? 0);

export async function getSummary(period: Period, zoneId?: string) {
  const t = await getThresholds();
  const zoneBin = zoneId ? Prisma.sql`AND b."zoneId" = ${zoneId}` : Prisma.empty;

  const [bins, vehicles, routesInProgress, stops, coll, byZone, planned, saved, alerts, origins] = await Promise.all([
    prisma.$queryRaw<Record<string, number>[]>`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE b.status = 'NEEDS_COLLECTION')::int AS "needsCollection",
             COUNT(*) FILTER (WHERE b.status = 'OVERFLOWING')::int AS overflowing,
             COUNT(*) FILTER (WHERE b.status <> 'OUT_OF_SERVICE' AND b."fillPercent" >= ${t.criticalPercent}::int)::int AS critical,
             COUNT(*) FILTER (WHERE b.status = 'OUT_OF_SERVICE')::int AS "outOfService"
      FROM "Bin" b WHERE TRUE ${zoneBin}`,
    prisma.vehicle.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.route.count({ where: { status: 'IN_PROGRESS' } }),
    prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT s.status, COUNT(*)::int AS count
      FROM "RouteStop" s JOIN "Route" r ON r.id = s."routeId" JOIN "Bin" b ON b.id = s."binId"
      WHERE r."plannedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        AND r.status IN ('PUBLISHED', 'IN_PROGRESS', 'COMPLETED') ${zoneBin}
      GROUP BY s.status`,
    prisma.$queryRaw<Record<string, number>[]>`
      SELECT COUNT(*) FILTER (WHERE c.outcome IN ('COLLECTED', 'PARTIAL'))::int AS collected,
             COUNT(*) FILTER (WHERE c.outcome IN ('INACCESSIBLE', 'FAILED'))::int AS failed,
             COALESCE(SUM(c."quantityLiters"), 0)::int AS liters,
             COUNT(c."quantityLiters")::int AS "withQuantity"
      FROM "CollectionRecord" c JOIN "Bin" b ON b.id = c."binId"
      WHERE c."collectedAt" >= ${period.from}::date AND c."collectedAt" < (${period.to}::date + 1) ${zoneBin}`,
    prisma.$queryRaw<{ zone: string; collected: number; liters: number }[]>`
      SELECT z.code AS zone,
             COUNT(*) FILTER (WHERE c.outcome IN ('COLLECTED', 'PARTIAL'))::int AS collected,
             COALESCE(SUM(c."quantityLiters"), 0)::int AS liters
      FROM "CollectionRecord" c JOIN "Bin" b ON b.id = c."binId" JOIN "Zone" z ON z.id = b."zoneId"
      WHERE c."collectedAt" >= ${period.from}::date AND c."collectedAt" < (${period.to}::date + 1) ${zoneBin}
      GROUP BY z.code ORDER BY z.code`,
    prisma.$queryRaw<{ distance: number }[]>`
      SELECT COALESCE(SUM("totalDistanceM"), 0)::int AS distance FROM "Route"
      WHERE "plannedDate" BETWEEN ${period.from}::date AND ${period.to}::date AND status IN ('PUBLISHED', 'IN_PROGRESS', 'COMPLETED')`,
    // Only plans where the baseline was comparable carry a baseline distance (see optimizer docs).
    prisma.$queryRaw<{ saved: number | null; plans: number }[]>`
      SELECT SUM(res."baselineDistanceM" - res."optimizedDistanceM")::int AS saved, COUNT(*)::int AS plans
      FROM "OptimizationResult" res JOIN "OptimizationJob" j ON j.id = res."jobId"
      WHERE res."baselineDistanceM" > 0 AND j."plannedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        AND EXISTS (SELECT 1 FROM "Route" r WHERE r."jobId" = j.id AND r.status IN ('PUBLISHED', 'IN_PROGRESS', 'COMPLETED'))`,
    prisma.alert.groupBy({ by: ['severity'], where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, _count: { _all: true } }),
    prisma.$queryRaw<{ origin: string; count: number }[]>`SELECT origin::text AS origin, COUNT(*)::int AS count FROM "Bin" GROUP BY origin`,
  ]);

  const stopBy = Object.fromEntries(stops.map((s) => [s.status, s.count]));
  const completed = n(stopBy.COMPLETED);
  const closedBad = n(stopBy.SKIPPED) + n(stopBy.FAILED);
  const totalStops = stops.reduce((a, s) => a + s.count, 0);
  const vBy = Object.fromEntries(vehicles.map((v) => [v.status, v._count._all]));

  return {
    period,
    zoneId: zoneId ?? null,
    bins: bins[0],
    vehicles: {
      available: n(vBy.AVAILABLE), onRoute: n(vBy.ON_ROUTE), maintenance: n(vBy.MAINTENANCE), unavailable: n(vBy.UNAVAILABLE),
    },
    routesInProgress,
    collections: {
      collected: n(coll[0]?.collected), failedOrSkipped: n(coll[0]?.failed),
      litersCollected: n(coll[0]?.liters), recordsWithQuantity: n(coll[0]?.withQuantity),
      note: 'litersCollected sums only records where the driver entered a quantity.',
    },
    collectionsByZone: byZone,
    completion: {
      completedStops: completed, skippedOrFailedStops: closedBad, pendingStops: totalStops - completed - closedBad, totalStops,
      // numerator = completed stops, denominator = all stops on published/in-progress/completed routes planned in the period
      rate: totalStops > 0 ? Math.round((completed / totalStops) * 1000) / 10 : null,
    },
    distance: {
      plannedMeters: n(planned[0]?.distance),
      savedVsBaselineMeters: n(saved[0]?.plans) > 0 ? n(saved[0]?.saved) : null,
      comparablePlans: n(saved[0]?.plans),
      note: 'Savings count only plans whose baseline served exactly the same bins; null when there is no comparable plan.',
    },
    openAlertsBySeverity: Object.fromEntries(alerts.map((a) => [a.severity, a._count._all])),
    dataOrigin: Object.fromEntries(origins.map((o) => [o.origin, o.count])),
    notYetImplemented: ['averageVehicleUtilization', 'recommendations'],
  };
}

export async function getActivity(limit: number) {
  const rows = await prisma.auditLog.findMany({
    where: { action: { not: 'auth.login_failed' } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { name: true, role: true } } },
  });
  return rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId, actor: r.actor, createdAt: r.createdAt }));
}

export async function getTopAlerts(limit: number) {
  return prisma.alert.findMany({
    where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });
}
