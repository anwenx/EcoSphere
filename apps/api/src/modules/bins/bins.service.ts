import { randomUUID } from 'node:crypto';
import { Prisma, type BinStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../utils/errors';
import { reconcileBinAlerts } from '../alerts/alerts.service';
import { audit } from '../audit/audit.service';
import { DEFAULT_THRESHOLDS, deriveBinStatus, fillCategory, type Thresholds } from './bin-rules';
import type { CreateBinBody, ListQuery, UpdateBinBody } from './bins.schemas';

interface BinRow {
  id: string;
  code: string;
  type: string;
  fillPercent: number;
  capacityLiters: number;
  status: BinStatus;
  zoneId: string;
  zoneCode: string;
  origin: string;
  lastCollectedAt: Date | null;
  version: number;
  updatedAt: Date;
  lat: number;
  lng: number;
}

const SELECT_BIN = Prisma.sql`
  SELECT b.id, b.code, b.type, b."fillPercent", b."capacityLiters", b.status, b."zoneId", z.code AS "zoneCode",
         b.origin, b."lastCollectedAt", b.version, b."updatedAt",
         ST_Y(b.location::geometry) AS lat, ST_X(b.location::geometry) AS lng
  FROM "Bin" b JOIN "Zone" z ON z.id = b."zoneId"`;

// Column names come from this whitelist only; user input never reaches the SQL text.
const SORT_COLUMNS = {
  code: 'b.code',
  fillPercent: 'b."fillPercent"',
  status: 'b.status',
  updatedAt: 'b."updatedAt"',
  lastCollectedAt: 'b."lastCollectedAt"',
} as const;

const toDto = (r: BinRow) => ({ ...r, fillCategory: fillCategory(r.fillPercent) });

export async function getThresholds(): Promise<Thresholds> {
  const row = await prisma.setting.findUnique({ where: { key: 'collection.thresholds' } });
  return { ...DEFAULT_THRESHOLDS, ...((row?.value as Partial<Thresholds> | null) ?? {}) };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

function parseBbox(bbox: string) {
  const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number) as [number, number, number, number];
  const ok =
    minLng >= -180 && maxLng <= 180 && minLat >= -90 && maxLat <= 90 && minLng < maxLng && minLat < maxLat;
  if (!ok) throw new AppError(400, 'VALIDATION_ERROR', 'bbox is out of range or not ordered min < max.');
  return { minLng, minLat, maxLng, maxLat };
}

export async function listBins(q: ListQuery) {
  const conds: Prisma.Sql[] = [];
  if (q.q) conds.push(Prisma.sql`b.code ILIKE ${'%' + escapeLike(q.q) + '%'}`);
  if (q.status) conds.push(Prisma.sql`b.status = ${q.status}::"BinStatus"`);
  if (q.zoneId) conds.push(Prisma.sql`b."zoneId" = ${q.zoneId}`);
  if (q.minFill !== undefined) conds.push(Prisma.sql`b."fillPercent" >= ${q.minFill}::int`);
  if (q.maxFill !== undefined) conds.push(Prisma.sql`b."fillPercent" <= ${q.maxFill}::int`);
  if (q.bbox) {
    const b = parseBbox(q.bbox);
    // `&&` on geography uses the GiST index (bin_location_gix).
    conds.push(
      Prisma.sql`b.location && ST_MakeEnvelope(${b.minLng}::float8, ${b.minLat}::float8, ${b.maxLng}::float8, ${b.maxLat}::float8, 4326)::geography`,
    );
  }
  const where = conds.length ? Prisma.sql`WHERE ${Prisma.join(conds, ' AND ')}` : Prisma.empty;
  const order = Prisma.raw(`${SORT_COLUMNS[q.sort]} ${q.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, b.id`);

  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<BinRow[]>(
      Prisma.sql`${SELECT_BIN} ${where} ORDER BY ${order} LIMIT ${q.pageSize}::int OFFSET ${(q.page - 1) * q.pageSize}::int`,
    ),
    prisma.$queryRaw<{ total: number }[]>(
      Prisma.sql`SELECT COUNT(*)::int AS total FROM "Bin" b ${where}`,
    ),
  ]);
  return { rows: rows.map(toDto), total: counts[0]?.total ?? 0 };
}

export async function getBin(id: string) {
  const rows = await prisma.$queryRaw<BinRow[]>(Prisma.sql`${SELECT_BIN} WHERE b.id = ${id}`);
  const row = rows[0];
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Bin not found.');
  return toDto(row);
}

async function assertActiveZone(zoneId: string) {
  const zone = await prisma.zone.findUnique({ where: { id: zoneId }, select: { isActive: true } });
  if (!zone || !zone.isActive) {
    throw new AppError(422, 'INVALID_ZONE', 'Zone does not exist or is inactive.');
  }
}

export async function createBin(input: CreateBinBody, actorId: string, requestId: unknown) {
  await assertActiveZone(input.zoneId);
  if (await prisma.bin.findUnique({ where: { code: input.code }, select: { id: true } })) {
    throw new AppError(409, 'CONFLICT', `A bin with code ${input.code} already exists.`);
  }
  const status = deriveBinStatus(input.fillPercent, await getThresholds());
  const id = randomUUID();
  // A concurrent duplicate is still caught by the unique index and mapped to 409 by the error handler.
  await prisma.$executeRaw`
    INSERT INTO "Bin" (id, code, type, location, "fillPercent", "capacityLiters", status, "zoneId", "updatedAt")
    VALUES (${id}, ${input.code}, ${input.type},
            ST_SetSRID(ST_MakePoint(${input.lng}::float8, ${input.lat}::float8), 4326)::geography,
            ${input.fillPercent}::int, ${input.capacityLiters}::int, ${status}::"BinStatus", ${input.zoneId}, now())`;
  await audit({ actorId, action: 'bin.create', entityType: 'Bin', entityId: id, meta: { code: input.code }, requestId });
  const bin = await getBin(id);
  await reconcileBinAlerts(prisma, bin, await getThresholds());
  return bin;
}

export async function updateBin(id: string, input: UpdateBinBody, actorId: string, requestId: unknown) {
  if (input.zoneId) await assertActiveZone(input.zoneId);
  const thresholds = await getThresholds();

  await prisma.$transaction(async (tx) => {
    const cur = (
      await tx.$queryRaw<{ version: number; status: BinStatus; fillPercent: number }[]>`
        SELECT version, status, "fillPercent" FROM "Bin" WHERE id = ${id} FOR UPDATE`
    )[0];
    if (!cur) throw new AppError(404, 'NOT_FOUND', 'Bin not found.');
    if (cur.version !== input.version) {
      throw new AppError(409, 'STALE_VERSION', 'This bin was changed by someone else. Reload and try again.', {
        currentVersion: cur.version,
      });
    }

    const fill = input.fillPercent ?? cur.fillPercent;
    const outOfService = input.outOfService ?? cur.status === 'OUT_OF_SERVICE';
    const status: BinStatus = outOfService ? 'OUT_OF_SERVICE' : deriveBinStatus(fill, thresholds);

    const sets: Prisma.Sql[] = [
      Prisma.sql`status = ${status}::"BinStatus"`,
      Prisma.sql`version = version + 1`,
      Prisma.sql`"updatedAt" = now()`,
    ];
    if (input.type) sets.push(Prisma.sql`type = ${input.type}`);
    if (input.fillPercent !== undefined) sets.push(Prisma.sql`"fillPercent" = ${input.fillPercent}::int`);
    if (input.capacityLiters !== undefined) sets.push(Prisma.sql`"capacityLiters" = ${input.capacityLiters}::int`);
    if (input.zoneId) sets.push(Prisma.sql`"zoneId" = ${input.zoneId}`);
    if (input.lat !== undefined && input.lng !== undefined) {
      sets.push(
        Prisma.sql`location = ST_SetSRID(ST_MakePoint(${input.lng}::float8, ${input.lat}::float8), 4326)::geography`,
      );
    }
    await tx.$executeRaw(Prisma.sql`UPDATE "Bin" SET ${Prisma.join(sets, ', ')} WHERE id = ${id}`);
  });

  const { version: _v, ...changes } = input;
  await audit({ actorId, action: 'bin.update', entityType: 'Bin', entityId: id, meta: changes, requestId });
  const bin = await getBin(id);
  await reconcileBinAlerts(prisma, bin, thresholds);
  return bin;
}
