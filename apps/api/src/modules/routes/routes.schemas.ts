import { z } from 'zod';

export const idParams = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  vehicleId: z.string().uuid().optional(),
  driverId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const publishBody = z.object({ version: z.number().int().min(1) });
export const assignDriverBody = z.object({ version: z.number().int().min(1), driverId: z.string().uuid() });
