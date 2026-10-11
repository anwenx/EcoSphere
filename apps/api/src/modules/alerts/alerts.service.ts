import { Prisma, type AlertSeverity, type AlertStatus, type AlertType, type BinStatus, type DataOrigin } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError, forbidden } from '../../utils/errors';
import { audit } from '../audit/audit.service';
import type { Thresholds } from '../bins/bin-rules';

type Db = Prisma.TransactionClient; // a PrismaClient is assignable to this
const OPEN: AlertStatus[] = ['OPEN', 'ACKNOWLEDGED'];

/**
 * Keeps OVERFLOW / CRITICAL_FILL alerts in line with a bin's current state: creates the right one if missing and
 * auto-resolves stale ones (e.g. after a collection). Safe to call repeatedly.
 */
export async function reconcileBinAlerts(
  db: Db,
  bin: { id: string; code: string; fillPercent: number; status: BinStatus },
  t: Thresholds,
  origin: DataOrigin = 'REAL',
) {
  const wanted: { type: AlertType; severity: AlertSeverity; description: string } | null =
    bin.status === 'OUT_OF_SERVICE'
      ? null
      : bin.status === 'OVERFLOWING'
        ? { type: 'OVERFLOW', severity: 'CRITICAL', description: `Bin ${bin.code} is overflowing (${bin.fillPercent}% full).` }
        : bin.fillPercent >= t.criticalPercent
          ? { type: 'CRITICAL_FILL', severity: 'WARNING', description: `Bin ${bin.code} is at a critical fill level (${bin.fillPercent}%).` }
          : null;

  const open = await db.alert.findMany({
    where: { entityType: 'Bin', entityId: bin.id, type: { in: ['OVERFLOW', 'CRITICAL_FILL'] }, status: { in: OPEN } },
  });
  for (const a of open) {
    if (!wanted || a.type !== wanted.type) {
      await db.alert.update({
        where: { id: a.id },
        data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: `Auto-resolved: fill level is now ${bin.fillPercent}% (${bin.status}).` },
      });
    }
  }
  if (wanted && !open.some((a) => a.type === wanted.type)) {
    await db.alert.create({ data: { ...wanted, entityType: 'Bin', entityId: bin.id, origin } });
  }
}

export async function raiseAlert(
  db: Db,
  a: { type: AlertType; severity: AlertSeverity; entityType: string; entityId: string; description: string },
) {
  return db.alert.create({ data: a });
}

export async function listAlerts(q: {
  status?: AlertStatus; severity?: AlertSeverity; type?: AlertType; page: number; pageSize: number;
}) {
  const where: Prisma.AlertWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.severity ? { severity: q.severity } : {}),
    ...(q.type ? { type: q.type } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.alert.findMany({
      where, orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
    }),
    prisma.alert.count({ where }),
  ]);
  return { rows, total };
}

async function transition(id: string, from: AlertStatus[], data: Prisma.AlertUncheckedUpdateManyInput) {
  const res = await prisma.alert.updateMany({ where: { id, status: { in: from } }, data });
  if (res.count === 0) {
    const cur = await prisma.alert.findUnique({ where: { id }, select: { status: true } });
    if (!cur) throw new AppError(404, 'NOT_FOUND', 'Alert not found.');
    throw new AppError(409, 'INVALID_TRANSITION', `Alert is ${cur.status} and cannot be changed this way.`);
  }
  return prisma.alert.findUniqueOrThrow({ where: { id } });
}

export async function acknowledgeAlert(id: string, actorId: string, requestId: unknown) {
  const a = await transition(id, ['OPEN'], { status: 'ACKNOWLEDGED' });
  await audit({ actorId, action: 'alert.acknowledge', entityType: 'Alert', entityId: id, requestId });
  return a;
}

export async function assignAlert(id: string, userId: string, actorId: string, requestId: unknown) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, isActive: true } });
  if (!u || !u.isActive || u.role === 'DRIVER') {
    throw new AppError(422, 'INVALID_ASSIGNEE', 'Alerts can only be assigned to active admins or managers.');
  }
  const a = await transition(id, OPEN, { assignedToId: userId });
  await audit({ actorId, action: 'alert.assign', entityType: 'Alert', entityId: id, meta: { userId }, requestId });
  return a;
}

export async function resolveAlert(id: string, resolution: string, actorId: string, requestId: unknown) {
  const a = await transition(id, OPEN, { status: 'RESOLVED', resolution, resolvedById: actorId, resolvedAt: new Date() });
  await audit({ actorId, action: 'alert.resolve', entityType: 'Alert', entityId: id, meta: { resolution }, requestId });
  return a;
}

/** Dismissing a CRITICAL alert is reserved for admins. */
export async function dismissAlert(id: string, reason: string | undefined, actor: { id: string; role: string }, requestId: unknown) {
  const cur = await prisma.alert.findUnique({ where: { id }, select: { severity: true } });
  if (!cur) throw new AppError(404, 'NOT_FOUND', 'Alert not found.');
  if (cur.severity === 'CRITICAL' && actor.role !== 'ADMIN') throw forbidden();
  const a = await transition(id, OPEN, { status: 'DISMISSED', resolution: reason ?? 'Dismissed', resolvedById: actor.id, resolvedAt: new Date() });
  await audit({ actorId: actor.id, action: 'alert.dismiss', entityType: 'Alert', entityId: id, meta: { reason }, requestId });
  return a;
}
