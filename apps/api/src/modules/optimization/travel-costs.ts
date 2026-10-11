import { createHash } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';

export interface LatLng {
  lat: number;
  lng: number;
}
export interface TravelMatrix {
  distance_m: number[][];
  duration_s: number[][];
  source: 'OSRM_ROAD';
}
export interface MatrixResult {
  matrix: TravelMatrix | null;
  warning?: string; // set whenever we fell back to the (labeled) straight-line approximation
}

const OSRM_MAX_POINTS = 100; // default --max-table-size of osrm-routed
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 20;
const cache = new Map<string, { at: number; matrix: TravelMatrix }>();

const tableSchema = z.object({
  code: z.literal('Ok'),
  distances: z.array(z.array(z.number().nullable())),
  durations: z.array(z.array(z.number().nullable())),
});

const FALLBACK = 'using straight-line approximation (not road distance)';

/** One batched OSRM /table request (never one request per pair), cached by coordinate set. */
export async function getTravelMatrix(points: LatLng[]): Promise<MatrixResult> {
  if (!env.OSRM_BASE_URL) {
    return { matrix: null, warning: `OSRM_BASE_URL is not configured; ${FALLBACK}.` };
  }
  if (points.length > OSRM_MAX_POINTS) {
    return { matrix: null, warning: `${points.length} points exceed OSRM's default table limit (${OSRM_MAX_POINTS}); ${FALLBACK}.` };
  }

  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const key = createHash('sha1').update(coords).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { matrix: hit.matrix };

  try {
    const url = `${env.OSRM_BASE_URL.replace(/\/$/, '')}/table/v1/driving/${coords}?annotations=distance,duration`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = tableSchema.parse(await res.json());

    const n = points.length;
    const square = (m: (number | null)[][]) => m.length === n && m.every((row) => row.length === n);
    if (!square(body.distances) || !square(body.durations)) throw new Error('unexpected matrix shape');
    const toInts = (m: (number | null)[][]) =>
      m.map((row) =>
        row.map((v) => {
          if (v === null || v < 0) throw new Error('unreachable pair in matrix');
          return Math.round(v);
        }),
      );
    const matrix: TravelMatrix = {
      distance_m: toInts(body.distances),
      duration_s: toInts(body.durations),
      source: 'OSRM_ROAD',
    };

    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), matrix });
    return { matrix };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ reason }, 'OSRM matrix request failed');
    return { matrix: null, warning: `OSRM request failed (${reason}); ${FALLBACK}.` };
  }
}
