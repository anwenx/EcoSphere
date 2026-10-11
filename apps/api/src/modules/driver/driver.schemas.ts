import { z } from 'zod';

export const idParams = z.object({ id: z.string().uuid() });

export const completeBody = z
  .object({
    outcome: z.enum(['COLLECTED', 'PARTIAL', 'INACCESSIBLE', 'FAILED']),
    fillBefore: z.number().int().min(0).max(100), // what the driver observed on arrival
    fillAfter: z.number().int().min(0).max(100).optional(), // COLLECTED defaults to 0
    quantityLiters: z.number().int().min(0).max(50_000).optional(), // only if actually known
    notes: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    const collected = v.outcome === 'COLLECTED' || v.outcome === 'PARTIAL';
    const bad = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    if (!collected && (v.fillAfter !== undefined || v.quantityLiters !== undefined)) {
      bad('fillAfter and quantityLiters only apply to COLLECTED or PARTIAL', 'outcome');
    }
    if (v.outcome === 'PARTIAL' && v.fillAfter === undefined) bad('fillAfter is required for PARTIAL', 'fillAfter');
    if (v.fillAfter !== undefined && v.fillAfter > v.fillBefore) bad('fillAfter cannot exceed fillBefore', 'fillAfter');
    if (!collected && !v.notes) bad('notes are required to explain a skipped or failed stop', 'notes');
  });

export const issueBody = z.object({
  type: z.enum(['BLOCKED_ROAD', 'INACCESSIBLE_BIN', 'VEHICLE_ISSUE']),
  routeId: z.string().uuid().optional(),
  binId: z.string().uuid().optional(),
  vehicleId: z.string().uuid().optional(),
  notes: z.string().trim().min(3).max(500),
});

export const listQuery = z.object({
  includeCompleted: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type CompleteBody = z.infer<typeof completeBody>;
export type IssueBody = z.infer<typeof issueBody>;
