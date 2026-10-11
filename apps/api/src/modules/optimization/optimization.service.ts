import { Prisma, type BinStatus, type JobStatus } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import { getThresholds } from '../bins/bins.service';
import type { Thresholds } from '../bins/bin-rules';
import { callOptimizer, type OptimizerResponse } from './optimizer-client';
import type { CreateJobBody, SavePlanBody } from './optimization.schemas';
import { getTravelMatrix } from './travel-costs';

interface OptimizerReq {
  depot: { lat: number; lng: number };
  vehicles: { id: string; capacity_liters: number; max_stops?: number; max_duration_s: number }[];
  bins: { id: string; lat: number; lng: number; demand_liters: number; service_s: number; priority: number }[];
  objective: string;
  time_limit_s: number;
}
interface StoredParams {
  input: CreateJobBody;
  optimizerRequest: OptimizerReq;
  binCodes: Record<string, string>;
}
interface StoredResult {
  routes: OptimizerResponse['routes'];
  baselineRoutes: OptimizerResponse['baseline_routes'];
  comparison: OptimizerResponse['comparison'];
  assumptions: OptimizerResponse['assumptions'];
  warnings: string[];
}

interface EligibleBin {
  id: string;
  code: string;
  fillPercent: number;
  capacityLiters: number;
  status: BinStatus;
  lat: number;
  lng: number;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

const BIN_COLUMNS = Prisma.sql`b.id, b.code, b."fillPercent", b."capacityLiters", b.status,
  ST_Y(b.location::geometry) AS lat, ST_X(b.location::geometry) AS lng`;

async function selectBins(input: CreateJobBody, t: Thresholds): Promise<EligibleBin[]> {
  if (input.binIds) {
    const rows = await prisma.$queryRaw<EligibleBin[]>(
      Prisma.sql`SELECT ${BIN_COLUMNS} FROM "Bin" b WHERE b.id = ANY(${input.binIds}::text[])`,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const bad = input.binIds.flatMap((id) => {
      const b = byId.get(id);
      if (!b) return [{ id, problem: 'NOT_FOUND' }];
      return b.status === 'OUT_OF_SERVICE' ? [{ id, code: b.code, problem: 'OUT_OF_SERVICE' }] : [];
    });
    if (bad.length) throw new AppError(422, 'INVALID_BINS', 'Some selected bins cannot be collected.', bad);
    return rows;
  }
  const zoneCond = input.zoneIds?.length ? Prisma.sql`AND b."zoneId" = ANY(${input.zoneIds}::text[])` : Prisma.empty;
  return prisma.$queryRaw<EligibleBin[]>(Prisma.sql`
    SELECT ${BIN_COLUMNS} FROM "Bin" b
    WHERE b.status <> 'OUT_OF_SERVICE' AND b."fillPercent" >= ${t.needsCollectionPercent}::int ${zoneCond}
    ORDER BY b."fillPercent" DESC, b.code LIMIT 2000`);
}

/** Priority 3 = overflowing, 2 = at/over the critical fill threshold, otherwise 1 (overridable per bin). */
function priorityOf(b: EligibleBin, t: Thresholds, overrides?: Record<string, 1 | 2 | 3>): number {
  const o = overrides?.[b.id];
  if (o) return o;
  if (b.status === 'OVERFLOWING') return 3;
  return b.fillPercent >= t.criticalPercent ? 2 : 1;
}

export async function createJob(input: CreateJobBody, actorId: string, requestId: unknown) {
  if (!env.OPTIMIZER_SERVICE_TOKEN) {
    throw new AppError(503, 'OPTIMIZER_NOT_CONFIGURED', 'Optimization is disabled: OPTIMIZER_SERVICE_TOKEN is not set.');
  }

  const depot = (
    await prisma.$queryRaw<{ id: string; lat: number; lng: number }[]>`
      SELECT id, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM "Depot" WHERE id = ${input.depotId} AND "isActive" = true`
  )[0];
  if (!depot) throw new AppError(422, 'INVALID_DEPOT', 'Depot does not exist or is inactive.');

  const vehicles = await prisma.vehicle.findMany({ where: { id: { in: input.vehicleIds } } });
  const vById = new Map(vehicles.map((v) => [v.id, v]));
  const badVehicles = input.vehicleIds.flatMap((id) => {
    const v = vById.get(id);
    if (!v) return [{ id, problem: 'NOT_FOUND' }];
    return v.status === 'AVAILABLE' ? [] : [{ id, code: v.code, problem: `NOT_AVAILABLE (${v.status})` }];
  });
  if (badVehicles.length) {
    throw new AppError(422, 'INVALID_VEHICLES', 'Some selected vehicles cannot be assigned.', badVehicles);
  }

  const unknownOverrides = [
    ...Object.keys(input.capacityOverridesLiters ?? {}).filter((id) => !vById.has(id)),
    ...Object.keys(input.priorityOverrides ?? {}).filter((id) => input.binIds && !input.binIds.includes(id)),
  ];
  if (unknownOverrides.length) {
    throw new AppError(422, 'INVALID_OVERRIDES', 'Overrides reference ids that are not part of this job.', unknownOverrides);
  }

  const thresholds = await getThresholds();
  const bins = await selectBins(input, thresholds);
  if (!bins.length) throw new AppError(422, 'NO_ELIGIBLE_BINS', 'No bins match the selection criteria.');

  // Waste estimate = capacity x fill%. This is an assumption (uniform density), not a measured quantity.
  const optimizerRequest: OptimizerReq = {
    depot: { lat: depot.lat, lng: depot.lng },
    vehicles: input.vehicleIds.map((id) => {
      const v = vById.get(id)!;
      return {
        id,
        capacity_liters: input.capacityOverridesLiters?.[id] ?? v.capacityLiters,
        ...(v.maxStops ? { max_stops: v.maxStops } : {}),
        max_duration_s: input.maxRouteDurationMin * 60,
      };
    }),
    bins: bins.map((b) => ({
      id: b.id,
      lat: b.lat,
      lng: b.lng,
      demand_liters: Math.round((b.capacityLiters * b.fillPercent) / 100),
      service_s: input.serviceSecondsPerBin,
      priority: priorityOf(b, thresholds, input.priorityOverrides as Record<string, 1 | 2 | 3> | undefined),
    })),
    objective: input.objective,
    time_limit_s: input.timeLimitS,
  };
  const params: StoredParams = {
    input,
    optimizerRequest,
    binCodes: Object.fromEntries(bins.map((b) => [b.id, b.code])),
  };

  const job = await prisma.optimizationJob.create({
    data: { requestedById: actorId, plannedDate: new Date(input.plannedDate), params: json(params) },
  });
  await audit({
    actorId, action: 'optimization.job_created', entityType: 'OptimizationJob', entityId: job.id,
    meta: { bins: bins.length, vehicles: input.vehicleIds.length, plannedDate: input.plannedDate }, requestId,
  });

  // Background execution inside this process. Not safe for multiple API instances without a queue (see docs).
  setImmediate(() => {
    runJob(job.id).catch((err) => logger.error({ err, jobId: job.id }, 'optimization job runner crashed'));
  });
  return getJob(job.id);
}

async function failJob(jobId: string, status: JobStatus, message: string) {
  await prisma.optimizationJob.update({ where: { id: jobId }, data: { status, error: message, finishedAt: new Date() } });
  await prisma.alert.create({
    data: {
      type: 'OPTIMIZATION_FAILURE', severity: 'WARNING', entityType: 'OptimizationJob', entityId: jobId,
      description: `Route optimization failed: ${message}`,
    },
  });
}

function assertConsistent(req: OptimizerReq, res: OptimizerResponse) {
  const binIds = new Set(req.bins.map((b) => b.id));
  const vehicleIds = new Set(req.vehicles.map((v) => v.id));
  const seen = new Set<string>();
  for (const r of res.routes) {
    if (!vehicleIds.has(r.vehicle_id)) throw new AppError(502, 'OPTIMIZER_BAD_RESPONSE', 'Optimizer returned an unknown vehicle.');
    for (const s of r.stops) {
      if (!binIds.has(s.bin_id) || seen.has(s.bin_id)) {
        throw new AppError(502, 'OPTIMIZER_BAD_RESPONSE', 'Optimizer returned an unknown or duplicated bin.');
      }
      seen.add(s.bin_id);
    }
  }
  for (const u of res.unassigned) {
    if (!binIds.has(u.bin_id) || seen.has(u.bin_id)) {
      throw new AppError(502, 'OPTIMIZER_BAD_RESPONSE', 'Optimizer returned an inconsistent unassigned list.');
    }
    seen.add(u.bin_id);
  }
  if (seen.size !== binIds.size) {
    throw new AppError(502, 'OPTIMIZER_BAD_RESPONSE', 'Optimizer did not account for every bin.');
  }
}

async function runJob(jobId: string) {
  const job = await prisma.optimizationJob.update({
    where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() },
  });
  const params = job.params as unknown as StoredParams;
  const req = params.optimizerRequest;

  try {
    const { matrix, warning } = await getTravelMatrix([req.depot, ...req.bins]);
    const res = await callOptimizer(matrix ? { ...req, matrix } : req);
    assertConsistent(req, res);

    // Persist only validated results.
    if (!res.validated) {
      const detail = res.violations.slice(0, 3).map((v) => `${v.code}: ${v.detail}`).join('; ');
      await failJob(jobId, 'FAILED', `Optimizer result failed validation (${detail || 'no detail'}).`);
      return;
    }

    const stored: StoredResult = {
      routes: res.routes, baselineRoutes: res.baseline_routes, comparison: res.comparison,
      assumptions: res.assumptions, warnings: warning ? [warning] : [],
    };
    await prisma.$transaction(async (tx) => {
      await tx.optimizationResult.create({
        data: {
          jobId,
          solverStatus: res.solver_status,
          costSource: res.cost_source,
          objectiveValue: res.objective_value === null ? null : BigInt(Math.round(res.objective_value)),
          optimizedDistanceM: res.routes.reduce((a, r) => a + r.distance_m, 0),
          baselineDistanceM: res.comparison.baseline_distance_m,
          distanceReductionPercent: res.comparison.distance_reduction_percent,
          routesJson: json(stored),
          unassignedJson: json(res.unassigned),
          violationsJson: json(res.violations),
          validated: true,
        },
      });
      await tx.optimizationJob.update({ where: { id: jobId }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
    });

    // Alert (once per bin) when a critical-priority bin could not be assigned.
    const priority = new Map(req.bins.map((b) => [b.id, b.priority]));
    for (const u of res.unassigned) {
      if (priority.get(u.bin_id) !== 3) continue;
      const open = await prisma.alert.findFirst({
        where: { type: 'UNASSIGNED_CRITICAL_BIN', entityType: 'Bin', entityId: u.bin_id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      });
      if (open) continue;
      await prisma.alert.create({
        data: {
          type: 'UNASSIGNED_CRITICAL_BIN', severity: 'CRITICAL', entityType: 'Bin', entityId: u.bin_id,
          description: `Critical bin ${params.binCodes[u.bin_id] ?? u.bin_id} was left unassigned: ${u.reason}.`,
        },
      });
    }
  } catch (err) {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : 'Unexpected error while optimizing.';
    if (!(err instanceof AppError)) logger.error({ err, jobId }, 'optimization job failed');
    await failJob(jobId, err instanceof AppError && err.code === 'OPTIMIZER_TIMEOUT' ? 'TIMED_OUT' : 'FAILED', message);
  }
}

/** Called once at startup: jobs that were mid-flight when the process died can never finish. */
export async function failStaleJobs(): Promise<number> {
  const res = await prisma.optimizationJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    data: { status: 'FAILED', error: 'Interrupted by a server restart.', finishedAt: new Date() },
  });
  return res.count;
}

export async function getJob(id: string) {
  const job = await prisma.optimizationJob.findUnique({
    where: { id },
    include: { result: { select: { id: true, solverStatus: true, validated: true } }, _count: { select: { routes: true } } },
  });
  if (!job) throw new AppError(404, 'NOT_FOUND', 'Optimization job not found.');
  const params = job.params as unknown as StoredParams;
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    plannedDate: job.plannedDate.toISOString().slice(0, 10),
    objective: params.optimizerRequest.objective,
    binCount: params.optimizerRequest.bins.length,
    vehicleCount: params.optimizerRequest.vehicles.length,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    hasResult: job.result !== null,
    solverStatus: job.result?.solverStatus ?? null,
    routesSaved: job._count.routes,
  };
}

export async function getJobResult(id: string) {
  const result = await prisma.optimizationResult.findUnique({ where: { jobId: id } });
  if (!result) {
    const job = await prisma.optimizationJob.findUnique({ where: { id }, select: { status: true } });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Optimization job not found.');
    throw new AppError(409, 'RESULT_NOT_READY', `Job is ${job.status}; no validated result is available.`);
  }
  const stored = result.routesJson as unknown as StoredResult;
  const unassigned = result.unassignedJson as unknown as OptimizerResponse['unassigned'];
  const ids = [...new Set([...stored.routes.flatMap((r) => r.stops.map((s) => s.bin_id)),
    ...stored.baselineRoutes.flatMap((r) => r.stops.map((s) => s.bin_id)), ...unassigned.map((u) => u.bin_id)])];
  const bins = ids.length
    ? await prisma.$queryRaw<{ id: string; code: string; fillPercent: number; zoneCode: string; lat: number; lng: number }[]>`
        SELECT b.id, b.code, b."fillPercent", z.code AS "zoneCode",
               ST_Y(b.location::geometry) AS lat, ST_X(b.location::geometry) AS lng
        FROM "Bin" b JOIN "Zone" z ON z.id = b."zoneId" WHERE b.id = ANY(${ids}::text[])`
    : [];
  return {
    solverStatus: result.solverStatus,
    costSource: result.costSource,
    objectiveValue: result.objectiveValue === null ? null : Number(result.objectiveValue),
    validated: result.validated,
    routes: stored.routes,
    baselineRoutes: stored.baselineRoutes,
    comparison: stored.comparison,
    unassigned,
    violations: result.violationsJson,
    assumptions: stored.assumptions,
    warnings: stored.warnings,
    bins: Object.fromEntries(bins.map((b) => [b.id, b])),
  };
}

/** Persists the validated plan as DRAFT routes + stops in one transaction (all or nothing). */
export async function savePlan(jobId: string, input: SavePlanBody, actorId: string, requestId: unknown) {
  const result = await prisma.optimizationResult.findUnique({ where: { jobId }, include: { job: true } });
  if (!result || !result.validated) {
    throw new AppError(409, 'NO_VALID_RESULT', 'This job has no validated result to save.');
  }
  const params = result.job.params as unknown as StoredParams;
  const stored = result.routesJson as unknown as StoredResult;
  const planned = stored.routes.filter((r) => r.stops.length > 0);
  if (!planned.length) throw new AppError(422, 'EMPTY_PLAN', 'The optimized plan contains no routes.');

  const vehicles = await prisma.vehicle.findMany({ where: { id: { in: planned.map((r) => r.vehicle_id) } } });
  const vById = new Map(vehicles.map((v) => [v.id, v]));
  const override = new Map(input.assignments.map((a) => [a.vehicleId, a.driverId]));
  for (const id of override.keys()) {
    if (!planned.some((r) => r.vehicle_id === id)) {
      throw new AppError(422, 'INVALID_ASSIGNMENT', 'Assignment references a vehicle that has no route in this plan.', { id });
    }
  }
  const driverFor = (vehicleId: string) => (override.has(vehicleId) ? override.get(vehicleId) ?? null : vById.get(vehicleId)?.driverId ?? null);

  const driverIds = [...new Set(planned.map((r) => driverFor(r.vehicle_id)).filter((d): d is string => !!d))];
  const drivers = await prisma.user.findMany({ where: { id: { in: driverIds }, role: 'DRIVER', isActive: true }, select: { id: true } });
  if (drivers.length !== driverIds.length) {
    throw new AppError(422, 'INVALID_DRIVER', 'A selected driver does not exist, is inactive, or is not a driver.');
  }

  const depot = await prisma.depot.findUnique({ where: { id: params.input.depotId }, select: { id: true, opensAt: true } });
  if (!depot) throw new AppError(422, 'INVALID_DEPOT', 'The depot for this plan no longer exists.');
  const [hh, mm] = depot.opensAt.split(':').map(Number) as [number, number];
  const d = result.job.plannedDate;
  const shiftStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm) - env.OPERATIONS_UTC_OFFSET_MINUTES * 60_000;
  const demand = new Map(params.optimizerRequest.bins.map((b) => [b.id, b.demand_liters]));
  const dateTag = result.job.plannedDate.toISOString().slice(0, 10).replaceAll('-', '');

  const created = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "OptimizationJob" WHERE id = ${jobId} FOR UPDATE`; // serialize concurrent saves
    if ((await tx.route.count({ where: { jobId } })) > 0) {
      throw new AppError(409, 'PLAN_ALREADY_SAVED', 'This plan was already saved.');
    }
    const out: { id: string; code: string }[] = [];
    for (const r of planned) {
      const v = vById.get(r.vehicle_id);
      if (!v) throw new AppError(422, 'INVALID_VEHICLES', 'A vehicle in the plan no longer exists.');
      out.push(
        await tx.route.create({
          data: {
            code: `R-${dateTag}-${v.code}-${jobId.slice(0, 6).toUpperCase()}`,
            plannedDate: result.job.plannedDate,
            vehicleId: v.id,
            driverId: driverFor(v.id),
            depotId: depot.id,
            jobId,
            totalDistanceM: r.distance_m,
            drivingSeconds: r.driving_s,
            serviceSeconds: r.service_s,
            costSource: result.costSource,
            stops: {
              create: r.stops.map((s) => ({
                binId: s.bin_id,
                stopOrder: s.order,
                estimatedArrival: new Date(shiftStartMs + s.start_service_s * 1000),
                serviceSeconds: s.service_s,
                expectedLiters: demand.get(s.bin_id) ?? null,
              })),
            },
          },
          select: { id: true, code: true },
        }),
      );
    }
    return out;
  });

  await audit({
    actorId, action: 'route.plan_saved', entityType: 'OptimizationJob', entityId: jobId,
    meta: { routes: created.map((c) => c.code) }, requestId,
  });
  return created;
}
