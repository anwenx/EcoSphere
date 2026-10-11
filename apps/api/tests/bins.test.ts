/**
 * Integration tests against the real development database (requires `npm run prisma:seed` first).
 * They create TEST-* bins and delete them afterwards. Test users are upserted and kept: AuditLog rows
 * reference them and the audit log is append-only by design.
 */
import { hash } from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

const app = createApp();
const PASSWORD = 'test-password-123';
const RUN = Date.now().toString(36).toUpperCase();
const CENTER = { lat: 12.9716, lng: 77.5946 };
let zoneId: string;

async function login(email: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { agent, csrf: res.body.data.csrfToken as string };
}

beforeAll(async () => {
  const passwordHash = await hash(PASSWORD);
  for (const [email, role] of [
    ['test-manager@ecosphere.test', 'MANAGER'],
    ['test-driver@ecosphere.test', 'DRIVER'],
  ] as const) {
    await prisma.user.upsert({
      where: { email },
      update: { passwordHash, role, isActive: true },
      create: { email, name: `Test ${role}`, role, passwordHash },
    });
  }
  const zone = await prisma.zone.findFirst({ where: { isActive: true } });
  if (!zone) throw new Error('No zones found. Run `npm run prisma:seed` first.');
  zoneId = zone.id;
});

afterAll(async () => {
  await prisma.bin.deleteMany({ where: { code: { startsWith: `TEST-${RUN}` } } });
  await prisma.$disconnect();
});

describe('bins API', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/bins');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('forbids drivers from creating bins', async () => {
    const { agent, csrf } = await login('test-driver@ecosphere.test');
    const res = await agent.post('/api/v1/bins').set('x-csrf-token', csrf).send({});
    expect(res.status).toBe(403);
  });

  it('rejects writes without a CSRF token', async () => {
    const { agent } = await login('test-manager@ecosphere.test');
    const res = await agent.post('/api/v1/bins').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('validates input (coordinates, fill, zone)', async () => {
    const { agent, csrf } = await login('test-manager@ecosphere.test');
    const bad = await agent
      .post('/api/v1/bins')
      .set('x-csrf-token', csrf)
      .send({ code: `TEST-${RUN}-BAD`, type: 'GENERAL', lat: 123, lng: 77, capacityLiters: 240, zoneId });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const badZone = await agent
      .post('/api/v1/bins')
      .set('x-csrf-token', csrf)
      .send({ code: `TEST-${RUN}-Z`, type: 'GENERAL', lat: 12.97, lng: 77.59, capacityLiters: 240, zoneId: crypto.randomUUID() });
    expect(badZone.status).toBe(422);
    expect(badZone.body.error.code).toBe('INVALID_ZONE');
  });

  it('creates, rejects duplicates, filters by bbox, and enforces optimistic concurrency', async () => {
    const { agent, csrf } = await login('test-manager@ecosphere.test');
    const code = `TEST-${RUN}-A`;
    const lat = CENTER.lat + 0.0123;
    const lng = CENTER.lng + 0.0123;
    const body = { code, type: 'GENERAL', lat, lng, capacityLiters: 660, fillPercent: 96, zoneId };

    const created = await agent.post('/api/v1/bins').set('x-csrf-token', csrf).send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('OVERFLOWING'); // derived server-side from fill
    expect(created.body.data.fillCategory).toBe('CRITICAL');
    expect(created.body.data.version).toBe(1);
    const id = created.body.data.id as string;

    const dup = await agent.post('/api/v1/bins').set('x-csrf-token', csrf).send(body);
    expect(dup.status).toBe(409);

    const near = `${lng - 0.0005},${lat - 0.0005},${lng + 0.0005},${lat + 0.0005}`;
    const hit = await agent.get('/api/v1/bins').query({ q: code, bbox: near });
    expect(hit.body.meta.total).toBe(1);
    expect(hit.body.data[0].lat).toBeCloseTo(lat, 6);
    expect(hit.body.data[0].lng).toBeCloseTo(lng, 6);

    const far = await agent.get('/api/v1/bins').query({ q: code, bbox: '10,10,10.1,10.1' });
    expect(far.body.meta.total).toBe(0);

    const upd = await agent.patch(`/api/v1/bins/${id}`).set('x-csrf-token', csrf).send({ version: 1, fillPercent: 10 });
    expect(upd.status).toBe(200);
    expect(upd.body.data.status).toBe('NORMAL');
    expect(upd.body.data.version).toBe(2);

    const stale = await agent.patch(`/api/v1/bins/${id}`).set('x-csrf-token', csrf).send({ version: 1, fillPercent: 50 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');

    const oos = await agent.patch(`/api/v1/bins/${id}`).set('x-csrf-token', csrf).send({ version: 2, outOfService: true });
    expect(oos.body.data.status).toBe('OUT_OF_SERVICE');
  });

  it('paginates, sorts, and rejects an unknown sort field', async () => {
    const { agent } = await login('test-manager@ecosphere.test');
    const page = await agent.get('/api/v1/bins').query({ pageSize: 10, sort: 'fillPercent', dir: 'desc' });
    expect(page.status).toBe(200);
    expect(page.body.data.length).toBeLessThanOrEqual(10);
    const fills = page.body.data.map((b: { fillPercent: number }) => b.fillPercent);
    expect([...fills].sort((a: number, b: number) => b - a)).toEqual(fills);

    const bad = await agent.get('/api/v1/bins').query({ sort: 'passwordHash' });
    expect(bad.status).toBe(400);
  });

  it('returns zone GeoJSON boundaries and depots', async () => {
    const { agent } = await login('test-manager@ecosphere.test');
    const zones = await agent.get('/api/v1/zones');
    expect(zones.status).toBe(200);
    expect(zones.body.data[0].boundary.type).toBe('Polygon');
    const depots = await agent.get('/api/v1/depots');
    expect(depots.status).toBe(200);
    expect(typeof depots.body.data[0].lat).toBe('number');
  });
});
