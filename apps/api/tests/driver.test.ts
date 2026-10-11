/**
 * Integration tests: driver workflow, alerts and dashboard against the real database
 * (requires `npm run prisma:seed`). Creates TEST-* bins, a TEST vehicle and a route for today; all removed afterwards.
 */
import { hash } from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

const app = createApp();
const PASSWORD = 'test-password-123';
const RUN = Date.now().toString(36).toUpperCase();
const TODAY = new Date().toISOString().slice(0, 10);

type Session = Awaited<ReturnType<typeof login>>;
let manager: Session, driver: Session, driver2: Session;
let zoneId: string, depotId: string, vehicleId: string, routeId: string;
let driverUserId: string;
const binIds: string[] = [];
const stopIds: string[] = [];

async function login(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.data.csrfToken as string };
}
const post = (s: Session, url: string, body: object = {}) => s.agent.post(url).set('x-csrf-token', s.csrf).send(body);

beforeAll(async () => {
  const passwordHash = await hash(PASSWORD);
  const users: Record<string, string> = {};
  for (const [email, role] of [['test-manager@ecosphere.test', 'MANAGER'], ['test-driver@ecosphere.test', 'DRIVER'], ['test-driver2@ecosphere.test', 'DRIVER']] as const) {
    const u = await prisma.user.upsert({
      where: { email }, update: { passwordHash, role, isActive: true },
      create: { email, name: `Test ${role}`, role, passwordHash },
    });
    users[email] = u.id;
  }
  driverUserId = users['test-driver@ecosphere.test']!;
  const zone = await prisma.zone.findFirst({ where: { isActive: true } });
  const depot = await prisma.depot.findFirst({ where: { isActive: true } });
  if (!zone || !depot) throw new Error('Seed data missing. Run `npm run prisma:seed` first.');
  zoneId = zone.id; depotId = depot.id;

  await prisma.vehicle.deleteMany({ where: { driverId: driverUserId } }); // leftover from an aborted run
  const vehicle = await prisma.vehicle.create({
    data: { code: `TEST-V-${RUN}`, type: 'Test truck', capacityLiters: 5000, status: 'AVAILABLE', driverId: driverUserId },
  });
  vehicleId = vehicle.id;

  manager = await login('test-manager@ecosphere.test');
  driver = await login('test-driver@ecosphere.test');
  driver2 = await login('test-driver2@ecosphere.test');

  for (const [i, fill] of [96, 85, 50].entries()) {
    const res = await post(manager, '/api/v1/bins', {
      code: `TEST-${RUN}-D${i + 1}`, type: 'GENERAL', lat: 12.97 + i * 0.001, lng: 77.59 + i * 0.001,
      capacityLiters: 660, fillPercent: fill, zoneId,
    });
    expect(res.status).toBe(201);
    binIds.push(res.body.data.id);
  }

  const route = await prisma.route.create({
    data: {
      code: `TEST-R-${RUN}`, plannedDate: new Date(TODAY), status: 'PUBLISHED', vehicleId, driverId: driverUserId, depotId,
      totalDistanceM: 5000, drivingSeconds: 900, serviceSeconds: 540,
      stops: { create: binIds.map((binId, i) => ({ binId, stopOrder: i + 1, estimatedArrival: new Date(), serviceSeconds: 180 })) },
    },
    include: { stops: { orderBy: { stopOrder: 'asc' } } },
  });
  routeId = route.id;
  stopIds.push(...route.stops.map((s) => s.id));
});

afterAll(async () => {
  await prisma.collectionRecord.deleteMany({ where: { binId: { in: binIds } } });
  await prisma.driverIssue.deleteMany({ where: { OR: [{ vehicleId }, { routeId }] } });
  await prisma.alert.deleteMany({ where: { entityId: { in: [...binIds, vehicleId, routeId] } } });
  await prisma.route.deleteMany({ where: { id: routeId } }); // stops cascade
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
  await prisma.bin.deleteMany({ where: { id: { in: binIds } } });
  await prisma.$disconnect();
});

describe('fill-level alerts', () => {
  it('are raised when bins are created at critical levels', async () => {
    const alerts = await prisma.alert.findMany({ where: { entityId: { in: binIds }, status: 'OPEN' } });
    expect(alerts.find((a) => a.entityId === binIds[0])?.type).toBe('OVERFLOW');
    expect(alerts.find((a) => a.entityId === binIds[1])?.type).toBe('CRITICAL_FILL');
    expect(alerts.some((a) => a.entityId === binIds[2])).toBe(false);
  });
});

describe('driver access control', () => {
  it('lists only the caller\'s routes and hides other drivers\' routes', async () => {
    const mine = await driver.agent.get('/api/v1/driver/routes');
    expect(mine.body.data.map((r: { id: string }) => r.id)).toContain(routeId);
    const other = await driver2.agent.get('/api/v1/driver/routes');
    expect(other.body.data.map((r: { id: string }) => r.id)).not.toContain(routeId);
    expect((await driver2.agent.get(`/api/v1/driver/routes/${routeId}`)).status).toBe(404);
    expect((await post(driver2, `/api/v1/driver/stops/${stopIds[0]}/complete`, { outcome: 'COLLECTED', fillBefore: 90 })).status).toBe(404);
  });

  it('keeps managers off driver endpoints and drivers off planner endpoints', async () => {
    expect((await manager.agent.get('/api/v1/driver/routes')).status).toBe(403);
    expect((await driver.agent.get('/api/v1/routes')).status).toBe(403);
    expect((await driver.agent.get('/api/v1/alerts')).status).toBe(403);
    expect((await driver.agent.get('/api/v1/dashboard/summary')).status).toBe(403);
  });

  it('shows the next stop with a navigation link', async () => {
    const res = await driver.agent.get(`/api/v1/driver/routes/${routeId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.nextStop.stopOrder).toBe(1);
    expect(res.body.data.nextStop.navigationUrl).toContain('google.com/maps/dir/');
    expect(res.body.data.progress).toEqual({ total: 3, completed: 0, remaining: 3 });
  });
});

describe('issue reports', () => {
  it('rejects foreign routes and raises a critical breakdown alert', async () => {
    expect((await post(driver2, '/api/v1/driver/issues', { type: 'BLOCKED_ROAD', routeId, notes: 'Road closed' })).status).toBe(404);
    const ok = await post(driver, '/api/v1/driver/issues', { type: 'VEHICLE_ISSUE', notes: 'Hydraulic lift is jammed' });
    expect(ok.status).toBe(201);
    const alert = await prisma.alert.findFirst({ where: { entityId: vehicleId, type: 'VEHICLE_BREAKDOWN' } });
    expect(alert?.severity).toBe('CRITICAL');
    const blocked = await post(driver, '/api/v1/driver/issues', { type: 'BLOCKED_ROAD', routeId, notes: 'Water main repair' });
    expect(blocked.status).toBe(201);
    expect((await post(driver, '/api/v1/driver/issues', { type: 'BLOCKED_ROAD', notes: 'no route given' })).status).toBe(400);
  });
});

describe('stop completion workflow', () => {
  it('validates the request body', async () => {
    const url = `/api/v1/driver/stops/${stopIds[0]}/complete`;
    expect((await post(driver, url, { outcome: 'PARTIAL', fillBefore: 90 })).status).toBe(400); // fillAfter required
    expect((await post(driver, url, { outcome: 'INACCESSIBLE', fillBefore: 90 })).status).toBe(400); // notes required
    expect((await post(driver, url, { outcome: 'COLLECTED', fillBefore: 50, fillAfter: 80 })).status).toBe(400);
    expect((await post(driver, url, { outcome: 'COLLECTED', fillBefore: 150 })).status).toBe(400);
  });

  it('enforces stop order', async () => {
    const res = await post(driver, `/api/v1/driver/stops/${stopIds[1]}/complete`, { outcome: 'COLLECTED', fillBefore: 85 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OUT_OF_ORDER');
  });

  it('collects stop 1: record, bin reset, route and vehicle states, alert auto-resolved; rejects duplicates', async () => {
    const res = await post(driver, `/api/v1/driver/stops/${stopIds[0]}/complete`, { outcome: 'COLLECTED', fillBefore: 96, quantityLiters: 500 });
    expect(res.status).toBe(201);
    expect(res.body.data.route.status).toBe('IN_PROGRESS');
    expect(res.body.data.route.nextStop.stopOrder).toBe(2);

    const bin = await prisma.bin.findUniqueOrThrow({ where: { id: binIds[0]! } });
    expect(bin.fillPercent).toBe(0);
    expect(bin.status).toBe('NORMAL');
    expect(bin.lastCollectedAt).not.toBeNull();
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).status).toBe('ON_ROUTE');
    const rec = await prisma.collectionRecord.findUniqueOrThrow({ where: { routeStopId: stopIds[0]! } });
    expect(rec).toMatchObject({ outcome: 'COLLECTED', fillBefore: 96, fillAfter: 0, quantityLiters: 500, driverId: driverUserId });
    const overflow = await prisma.alert.findFirstOrThrow({ where: { entityId: binIds[0]!, type: 'OVERFLOW' } });
    expect(overflow.status).toBe('RESOLVED');

    const dup = await post(driver, `/api/v1/driver/stops/${stopIds[0]}/complete`, { outcome: 'COLLECTED', fillBefore: 96 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('STOP_ALREADY_CLOSED');
    expect(await prisma.collectionRecord.count({ where: { routeStopId: stopIds[0]! } })).toBe(1);
  });

  it('skips an inaccessible bin (alert raised, bin untouched) and completes the route on the last stop', async () => {
    const skip = await post(driver, `/api/v1/driver/stops/${stopIds[1]}/complete`, { outcome: 'INACCESSIBLE', fillBefore: 85, notes: 'Car parked in front of bin' });
    expect(skip.status).toBe(201);
    const bin2 = await prisma.bin.findUniqueOrThrow({ where: { id: binIds[1]! } });
    expect(bin2.fillPercent).toBe(85);
    expect((await prisma.routeStop.findUniqueOrThrow({ where: { id: stopIds[1]! } })).status).toBe('SKIPPED');
    expect(await prisma.alert.count({ where: { entityId: binIds[1]!, type: 'FAILED_COLLECTION', status: 'OPEN' } })).toBe(1);

    const last = await post(driver, `/api/v1/driver/stops/${stopIds[2]}/complete`, { outcome: 'PARTIAL', fillBefore: 50, fillAfter: 10 });
    expect(last.status).toBe(201);
    expect(last.body.data.route.status).toBe('COMPLETED');
    expect(last.body.data.route.progress).toEqual({ total: 3, completed: 2, remaining: 0 });
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } })).status).toBe('AVAILABLE');
    expect((await prisma.bin.findUniqueOrThrow({ where: { id: binIds[2]! } })).fillPercent).toBe(10);

    const active = await driver.agent.get('/api/v1/driver/routes');
    expect(active.body.data.map((r: { id: string }) => r.id)).not.toContain(routeId);
    const closed = await post(driver, `/api/v1/driver/stops/${stopIds[2]}/complete`, { outcome: 'COLLECTED', fillBefore: 10 });
    expect(closed.status).toBe(409);
  });
});

describe('alerts API', () => {
  it('supports acknowledge, resolve and permission-limited dismissal', async () => {
    const alert = await prisma.alert.findFirstOrThrow({ where: { entityId: binIds[1]!, type: 'FAILED_COLLECTION', status: 'OPEN' } });
    const list = await manager.agent.get('/api/v1/alerts').query({ type: 'FAILED_COLLECTION', status: 'OPEN', pageSize: 100 });
    expect(list.body.data.map((a: { id: string }) => a.id)).toContain(alert.id);

    expect((await post(manager, `/api/v1/alerts/${alert.id}/acknowledge`)).body.data.status).toBe('ACKNOWLEDGED');
    expect((await post(manager, `/api/v1/alerts/${alert.id}/acknowledge`)).status).toBe(409);
    expect((await post(manager, `/api/v1/alerts/${alert.id}/resolve`, { resolution: 'x' })).status).toBe(400);
    const resolved = await post(manager, `/api/v1/alerts/${alert.id}/resolve`, { resolution: 'Moved the car, collected manually' });
    expect(resolved.body.data.status).toBe('RESOLVED');
    expect(resolved.body.data.resolvedById).not.toBeNull();
    expect(resolved.body.data.resolvedAt).not.toBeNull();
    expect((await post(manager, `/api/v1/alerts/${alert.id}/resolve`, { resolution: 'again please' })).status).toBe(409);

    const critical = await prisma.alert.findFirstOrThrow({ where: { entityId: vehicleId, type: 'VEHICLE_BREAKDOWN' } });
    expect((await post(manager, `/api/v1/alerts/${critical.id}/dismiss`, {})).status).toBe(403); // CRITICAL: admin only
  });
});

describe('dashboard and notifications', () => {
  it('reflects the completed stops, collections and skipped stop', async () => {
    const res = await manager.agent.get('/api/v1/dashboard/summary').query({ from: TODAY, to: TODAY });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.completion.completedStops).toBeGreaterThanOrEqual(2);
    expect(d.completion.skippedOrFailedStops).toBeGreaterThanOrEqual(1);
    expect(d.completion.rate).not.toBeNull();
    expect(d.collections.collected).toBeGreaterThanOrEqual(2);
    expect(d.collections.litersCollected).toBeGreaterThanOrEqual(500);
    expect(d.distance.savedVsBaselineMeters === null || typeof d.distance.savedVsBaselineMeters === 'number').toBe(true);

    const zone = await manager.agent.get('/api/v1/dashboard/summary').query({ from: TODAY, to: TODAY, zoneId });
    expect(zone.body.data.bins.total).toBeGreaterThanOrEqual(3);
    expect((await manager.agent.get('/api/v1/dashboard/summary').query({ from: '2026-12-31', to: '2026-01-01' })).status).toBe(400);
  });

  it('lists recent activity and the caller\'s own notifications only', async () => {
    const act = await manager.agent.get('/api/v1/dashboard/activity');
    expect(act.body.data.some((a: { action: string }) => a.action === 'stop.complete')).toBe(true);
    const mine = await driver.agent.get('/api/v1/notifications');
    expect(mine.status).toBe(200);
    const theirs = await driver2.agent.get('/api/v1/notifications');
    const mineIds = new Set(mine.body.data.map((n: { id: string }) => n.id));
    expect(theirs.body.data.some((n: { id: string }) => mineIds.has(n.id))).toBe(false);
  });
});
