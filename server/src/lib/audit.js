import { prisma } from '../db.js';

/**
 * Record an executive action. `client` may be a transaction client so the entry
 * commits (or rolls back) with the change it describes.
 */
export async function audit(req, action, entity, entityId, details, client = prisma) {
  await client.auditLog.create({
    data: {
      actorId: req?.user?.id ?? null,
      action,
      entity,
      entityId: entityId == null ? null : String(entityId),
      details: details ?? undefined,
      ip: req?.ip ?? null,
    },
  });
}
