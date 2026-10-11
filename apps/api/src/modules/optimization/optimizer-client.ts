import { z } from 'zod';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';

const stop = z.object({
  bin_id: z.string(),
  order: z.number().int(),
  start_service_s: z.number().int(),
  service_s: z.number().int(),
  load_after_l: z.number().int(),
});
const route = z.object({
  vehicle_id: z.string(),
  stops: z.array(stop),
  distance_m: z.number().int(),
  driving_s: z.number().int(),
  service_s: z.number().int(),
  duration_s: z.number().int(),
  load_l: z.number().int(),
  utilization_percent: z.number(),
});

export const optimizerResponse = z.object({
  solver_status: z.enum(['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'TIMED_OUT_FEASIBLE', 'FAILED']),
  raw_solver_status: z.number().nullable(),
  cost_source: z.enum(['OSRM_ROAD', 'STRAIGHT_LINE_APPROX']),
  objective: z.string(),
  objective_value: z.number().nullable(),
  routes: z.array(route),
  baseline_routes: z.array(route),
  unassigned: z.array(z.object({ bin_id: z.string(), reason: z.string(), detail: z.string() })),
  violations: z.array(z.object({ code: z.string(), detail: z.string(), vehicle_id: z.string().nullable().optional() })),
  validated: z.boolean(),
  comparison: z.object({
    comparable: z.boolean(),
    baseline_distance_m: z.number().nullable(),
    optimized_distance_m: z.number(),
    distance_reduction_percent: z.number().nullable(),
    baseline_bins_served: z.number(),
    optimized_bins_served: z.number(),
    note: z.string(),
  }),
  solve_time_ms: z.number(),
  assumptions: z.record(z.string(), z.unknown()),
});
export type OptimizerResponse = z.infer<typeof optimizerResponse>;

export async function callOptimizer(body: unknown): Promise<OptimizerResponse> {
  if (!env.OPTIMIZER_SERVICE_TOKEN) {
    throw new AppError(503, 'OPTIMIZER_NOT_CONFIGURED', 'Optimization is disabled: OPTIMIZER_SERVICE_TOKEN is not set.');
  }
  let res: Response;
  try {
    res = await fetch(`${env.OPTIMIZER_BASE_URL.replace(/\/$/, '')}/optimize`, {
      method: 'POST', // not retried: a solve is expensive and the job runner decides what a failure means
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPTIMIZER_SERVICE_TOKEN}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.OPTIMIZER_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AppError(504, 'OPTIMIZER_TIMEOUT', `The optimizer did not answer within ${env.OPTIMIZER_TIMEOUT_MS} ms.`);
    }
    throw new AppError(502, 'OPTIMIZER_UNAVAILABLE', 'The optimizer service could not be reached.');
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new AppError(502, 'OPTIMIZER_ERROR', `The optimizer returned HTTP ${res.status}.`, { body: text });
  }
  const parsed = optimizerResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(502, 'OPTIMIZER_BAD_RESPONSE', 'The optimizer returned a malformed response.');
  }
  return parsed.data;
}
