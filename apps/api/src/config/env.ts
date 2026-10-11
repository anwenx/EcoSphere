import 'dotenv/config';
import { z } from 'zod';

// Empty strings in .env mean "not set".
const blank = (v: unknown) => (v === '' ? undefined : v);
const optional = <T extends z.ZodType>(s: T) => z.preprocess(blank, s.optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters (generate: openssl rand -hex 32)'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  DEMO_MODE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  // Optimization (optional: without a token, job creation returns 503 and everything else keeps working)
  OPTIMIZER_BASE_URL: z.preprocess(blank, z.string().url().default('http://localhost:8000')),
  OPTIMIZER_SERVICE_TOKEN: optional(z.string().min(16)),
  OPTIMIZER_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  // Optional road-network matrix provider. Unset -> labeled straight-line approximation.
  OSRM_BASE_URL: optional(z.string().url()),
  // Shift start is the depot's opening time interpreted at this UTC offset (minutes, e.g. 330 for UTC+05:30).
  OPERATIONS_UTC_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
