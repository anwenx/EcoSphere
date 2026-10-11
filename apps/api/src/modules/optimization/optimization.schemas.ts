import { z } from 'zod';

const uuid = z.string().uuid();

export const createJobBody = z.object({
  plannedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date'),
  depotId: uuid,
  vehicleIds: z.array(uuid).min(1).max(50),
  zoneIds: z.array(uuid).max(50).optional(), // ignored when binIds is given
  binIds: z.array(uuid).min(1).max(2000).optional(), // explicit selection; otherwise bins at/over the collection threshold
  maxRouteDurationMin: z.number().int().min(30).max(720).default(480),
  serviceSecondsPerBin: z.number().int().min(0).max(1800).default(180),
  objective: z.enum(['MIN_DISTANCE', 'MIN_DURATION']).default('MIN_DISTANCE'),
  timeLimitS: z.number().int().min(1).max(60).default(10),
  capacityOverridesLiters: z.record(z.string(), z.number().int().min(100).max(50_000)).optional(),
  priorityOverrides: z.record(z.string(), z.union([z.literal(1), z.literal(2), z.literal(3)])).optional(),
});

export const savePlanBody = z.object({
  // Optional per-vehicle driver override; default is the vehicle's currently assigned driver.
  assignments: z
    .array(z.object({ vehicleId: uuid, driverId: uuid.nullable() }))
    .max(50)
    .default([]),
});

export const jobIdParams = z.object({ id: uuid });

export type CreateJobBody = z.infer<typeof createJobBody>;
export type SavePlanBody = z.infer<typeof savePlanBody>;
