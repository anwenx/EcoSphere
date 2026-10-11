import { z } from 'zod';

export const BIN_STATUSES = ['NORMAL', 'NEEDS_COLLECTION', 'OVERFLOWING', 'OUT_OF_SERVICE'] as const;
export const BIN_TYPES = ['GENERAL', 'RECYCLING', 'ORGANIC'] as const;

export const idParams = z.object({ id: z.string().uuid() });

export const listQuery = z
  .object({
    q: z.string().trim().max(64).optional(),
    status: z.enum(BIN_STATUSES).optional(),
    zoneId: z.string().uuid().optional(),
    minFill: z.coerce.number().int().min(0).max(100).optional(),
    maxFill: z.coerce.number().int().min(0).max(100).optional(),
    // minLng,minLat,maxLng,maxLat (WGS84). Bounding boxes crossing the antimeridian are not supported.
    bbox: z
      .string()
      .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'bbox must be minLng,minLat,maxLng,maxLat')
      .optional(),
    sort: z.enum(['code', 'fillPercent', 'status', 'updatedAt', 'lastCollectedAt']).default('code'),
    dir: z.enum(['asc', 'desc']).default('asc'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(50),
  })
  .refine((v) => v.minFill === undefined || v.maxFill === undefined || v.minFill <= v.maxFill, {
    message: 'minFill must be <= maxFill',
    path: ['minFill'],
  });

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

export const createBinBody = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(3)
    .max(32)
    .regex(/^[A-Z0-9-]+$/, 'Only letters, digits and hyphens'),
  type: z.enum(BIN_TYPES),
  lat,
  lng,
  capacityLiters: z.number().int().min(50).max(20_000),
  fillPercent: z.number().int().min(0).max(100).default(0),
  zoneId: z.string().uuid(),
});

export const updateBinBody = z
  .object({
    version: z.number().int().min(1), // optimistic concurrency token from the last read
    type: z.enum(BIN_TYPES).optional(),
    lat: lat.optional(),
    lng: lng.optional(),
    capacityLiters: z.number().int().min(50).max(20_000).optional(),
    fillPercent: z.number().int().min(0).max(100).optional(),
    zoneId: z.string().uuid().optional(),
    outOfService: z.boolean().optional(),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lat'],
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), { message: 'No fields to update' });

export type ListQuery = z.infer<typeof listQuery>;
export type CreateBinBody = z.infer<typeof createBinBody>;
export type UpdateBinBody = z.infer<typeof updateBinBody>;
