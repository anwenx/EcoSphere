import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

export interface AuditEntry {
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  meta?: Prisma.InputJsonValue;
  requestId?: unknown; // pino-http's request id type is wider than string
}

/** Append-only (a DB trigger rejects UPDATE/DELETE on AuditLog). Never put secrets in `meta`. */
export async function audit(entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      meta: entry.meta,
      requestId: entry.requestId == null ? undefined : String(entry.requestId),
    },
  });
}
