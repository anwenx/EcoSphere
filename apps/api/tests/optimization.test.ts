/**
 * Integration tests for the optimization -> plan -> publish workflow against the real database.
 * The OPTIMIZER SERVICE IS STUBBED here (global fetch is intercepted for http://optimizer.test): these tests
 * verify the API's own logic (selection, job lifecycle, persistence, transactions, conflicts, RBAC), not the solver.
 * The solver is covered by services/optimizer tests. Requires `npm run prisma:seed` first.
 */
import { hash } from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Runs before the imports below, so the app's config validation sees the stubbed optimizer URL.
vi.hoisted(() => {
  process.env.OPTIMIZER_BASE_URL = 'http://optimizer.test';
  process.env.OPTIMIZER_SERVICE_TOKEN = 'test-token-test-token-1234';
  process.env.OSRM_BASE_URL = '';
});
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

const app = createApp();
const PASSWORD = 'test-password-123';
const realFetch = globalThis.fetch;

type OptimizerBody = {
  vehicles: { id: string }[];
  bins: { id: string; demand_liters: number; service_s: number }[];
  objective: string;
};
let mode: 'ok' | 'invalid' | 'down' = 'ok';

function stubResponse(body: OptimizerBody, validated: boolean) {
  const n = body.bins.length;
  const stops = body.bins.map((b, i) => ({
    bin_id: b.id, order: i + 1, start_service_s: 600 * (i + 1), service_s: b.service_s, load_after_l: b.demand_liters,
  }));
  const route = {
    vehicle_id: body.vehicles[0]!.id, stops, distance_m: 1000 * (n + 1), driving_s: 120 * (n + 1),
    service_s: stops.reduce((a, s) => a + s.service_s, 0), duration_s: 3600, load_l: 100, utilization_percent: 10,
  };
  return {
    solver_status: 'FEASIBLE', raw_solver_status: 1, cost_source: 'STRAIGHT_LINE_APPROX', objective: body.objective,
    objective_value: 12345, routes: [route], baseline_routes: [route], unassigned: [],
    violations: validated ? [] : [{ code: 'CAPACITY', detail: 'stub violation', vehicle_id: null }], validated,
    comparison: {
      comparable: true, baseline_distance_m: route.distance_m, optimized_distance_m: route.distance_m,
      distance_reduction_percent: 0, baseline_bins_served: n, optimized_bins_served: n, note: 'stub',
    },
    solve_time_ms: 5, assumptions: { stub: true },
  };
}

vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
  if (!String(input).startsWith('http://optimizer.test')) return realFetch(input as string, init);
  if (mode === 'down') throw new TypeError('connect ECONNREFUSED');
  const body = JSON.parse(String(init?.body)) as OptimizerBody;
  return new Response(JSON.stringify(stubResponse(body, mode === 'ok')), { status: 200, headers: { 'content-type': 'application/json' } });
});

const jobIds: string[] = [];
let vehicleId: string;
let driverUserId: string;
let depotId: string;
let binIds: string[];
const DAY = new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 3000) * 86_400_000).toISOString().slice(0, 10);

async function login(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.data.csrfToken as string };
}

async function runJob(m: Awaited<ReturnType<typeof login>>, ids: string[]) {
  const created = await m.agent.post('/api/v1/optimization/jobs').set('x-csrf-token', m.csrf)
    .send({ plannedDate: DAY, depotId, vehicleIds: [vehicleId], binIds: ids, timeLimitS: 1 });
  expect(created.status).toBe(202);
  const id = created.body.data.id as string;
  jobIds.push(id);
  for (let i = 0; i < 60; i++) {
    const s = await m.agent.get(`/api/v1/optimization/jobs/${id}`);
    if (!['QUEUED', 'RUNNING'].includes(s.body.data.status)) return s.body.data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}

beforeAll(async () => {
  const passwordHash = await hash(PASSWORD);
  for (const [email, role] of [['test-manager@ecosphere.test', 'MANAGER'], ['test-driver@ecosphere.test', 'DRIVER']] as const) {
    await prisma.user.upsert({
      where: { email }, update: { passwordHash, role, isActive: true },
      create: { email, name: `Test ${role}`, role, passwordHash },
    });
  }
  const vehicle = await prisma.vehicle.findFirst({ where: { status: 'AVAILABLE', driverId: { not: null } }, orderBy: { code: 'asc' } });
  const depot = await prisma.depot.findFirst({ where: { isActive: true } });
  if (!vehicle || !depot) throw new Error('Seed data missing. Run `npm run prisma:seed` first.');
  vehicleId = vehicle.id; driverUserId = vehicle.driverId!; depotId = depot.id;

  const m = await login('test-manager@ecosphere.test');
  const bins = await m.agent.get('/api/v1/bins').query({ minFill: 70, pageSize: 20 });
  binIds = bins.body.data.filter((b: { status: string }) => b.status !== 'OUT_OF_SERVICE').map((b: { id: string }) => b.id);
  if (binIds.length < 6) throw new Error('Need at least 6 bins with fill >= 70 (re-run the seed).');
});

afterAll(async () => {
  const routes = await prisma.route.findMany({ where: { jobId: { in: jobIds } }, select: { code: true } });
  await prisma.route.deleteMany({ where: { jobId: { in: jobIds } } }); // stops cascade
  await prisma.optimizationJob.deleteMany({ where: { id: { in: jobIds } } }); // results cascade
  await prisma.alert.deleteMany({ where: { entityId: { in: jobIds } } });
  if (routes.length) await prisma.notification.deleteMany({ where: { OR: routes.map((r) => ({ body: { contains: r.code } })) } });
  await prisma.$disconnect();
});

describe('optimization workflow (optimizer stubbed)', () => {
  it('forbids drivers and requires CSRF', async () => {
    const d = await login('test-driver@ecosphere.test');
    const res = await d.agent.post('/api/v1/optimization/jobs').set('x-csrf-token', d.csrf).send({});
    expect(res.status).toBe(403);
    const m = await login('test-manager@ecosphere.test');
    expect((await m.agent.post('/api/v1/optimization/jobs').send({})).status).toBe(403);
  });

  it('rejects unusable vehicles, bins and invalid input before creating a job', async () => {
    const m = await login('test-manager@ecosphere.test');
    const base = { plannedDate: DAY, depotId, vehicleIds: [vehicleId], binIds: [binIds[0]] };
    const post = (b: object) => m.agent.post('/api/v1/optimization/jobs').set('x-csrf-token', m.csrf).send(b);
    const ghost = crypto.randomUUID();
    expect((await post({ ...base, vehicleIds: [ghost] })).body.error.code).toBe('INVALID_VEHICLES');
    expect((await post({ ...base, binIds: [ghost] })).body.error.code).toBe('INVALID_BINS');
    expect((await post({ ...base, depotId: ghost })).body.error.code).toBe('INVALID_DEPOT');
    expect((await post({ ...base, plannedDate: 'tomorrow' })).body.error.code).toBe('VALIDATION_ERROR');
    expect((await post({ ...base, timeLimitS: 9999 })).status).toBe(400);
  });

  it('runs a job, stores a validated result, saves a plan once, then publishes with version checks', async () => {
    const m = await login('test-manager@ecosphere.test');
    const job = await runJob(m, binIds.slice(0, 3));
    expect(job.status).toBe('SUCCEEDED');
    expect(job.hasResult).toBe(true);

    const result = await m.agent.get(`/api/v1/optimization/jobs/${job.id}/result`);
    expect(result.status).toBe(200);
    expect(result.body.data.validated).toBe(true);
    expect(result.body.data.routes[0].stops).toHaveLength(3);
    const first = result.body.data.routes[0].stops[0].bin_id as string;
    expect(typeof result.body.data.bins[first].lat).toBe('number'); // map-ready lookup

    const saved = await m.agent.post(`/api/v1/optimization/jobs/${job.id}/plan`).set('x-csrf-token', m.csrf).send({});
    expect(saved.status).toBe(201);
    const routeId = saved.body.data[0].id as string;
    const again = await m.agent.post(`/api/v1/optimization/jobs/${job.id}/plan`).set('x-csrf-token', m.csrf).send({});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PLAN_ALREADY_SAVED');

    const detail = await m.agent.get(`/api/v1/routes/${routeId}`);
    expect(detail.body.data.status).toBe('DRAFT');
    expect(detail.body.data.stops.map((s: { stopOrder: number }) => s.stopOrder)).toEqual([1, 2, 3]);
    expect(detail.body.data.progress).toEqual({ total: 3, completed: 0, remaining: 3 });
    expect(detail.body.data.driver.id).toBe(driverUserId);

    const stale = await m.agent.post(`/api/v1/routes/${routeId}/publish`).set('x-csrf-token', m.csrf).send({ version: 99 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');

    const pub = await m.agent.post(`/api/v1/routes/${routeId}/publish`).set('x-csrf-token', m.csrf).send({ version: 1 });
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe('PUBLISHED');
    expect(pub.body.data.version).toBe(2);
    expect(await prisma.notification.count({ where: { userId: driverUserId, body: { contains: detail.body.data.code } } })).toBe(1);

    const repub = await m.agent.post(`/api/v1/routes/${routeId}/publish`).set('x-csrf-token', m.csrf).send({ version: 2 });
    expect(repub.body.error.code).toBe('INVALID_TRANSITION');

    const list = await m.agent.get('/api/v1/routes').query({ date: DAY, status: 'PUBLISHED' });
    expect(list.body.data.some((r: { id: string }) => r.id === routeId)).toBe(true);
  });

  it('blocks a second active route for the same vehicle and date', async () => {
    const m = await login('test-manager@ecosphere.test');
    const job = await runJob(m, binIds.slice(3, 6));
    expect(job.status).toBe('SUCCEEDED');
    const saved = await m.agent.post(`/api/v1/optimization/jobs/${job.id}/plan`).set('x-csrf-token', m.csrf).send({});
    expect(saved.status).toBe(201);
    const pub = await m.agent.post(`/api/v1/routes/${saved.body.data[0].id}/publish`).set('x-csrf-token', m.csrf).send({ version: 1 });
    expect(pub.status).toBe(409);
    expect(pub.body.error.code).toBe('ROUTE_CONFLICT');
  });

  it('never persists a result that failed validation, and raises an alert', async () => {
    mode = 'invalid';
    const m = await login('test-manager@ecosphere.test');
    const job = await runJob(m, binIds.slice(0, 2));
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/failed validation/);
    expect(job.hasResult).toBe(false);
    expect((await m.agent.get(`/api/v1/optimization/jobs/${job.id}/result`)).status).toBe(409);
    expect(await prisma.alert.count({ where: { entityId: job.id, type: 'OPTIMIZATION_FAILURE' } })).toBe(1);
    mode = 'ok';
  });

  it('degrades gracefully when the optimizer is unreachable', async () => {
    mode = 'down';
    const m = await login('test-manager@ecosphere.test');
    const job = await runJob(m, binIds.slice(0, 2));
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/OPTIMIZER_UNAVAILABLE/);
    mode = 'ok';
  });
});
