import { Prisma, type AuditAction } from "@prisma/client";
import { prisma } from "../db";

// Writes one AuditLog row. Call this from every create, update and status change.
export async function audit(
  actorId: string | null,
  action: AuditAction,
  entityType: string,
  entityId: string,
  before?: unknown,
  after?: unknown
) {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      entityType,
      entityId,
      before: toJson(before),
      after: toJson(after),
    },
  });
}

// Prisma needs JsonNull (not plain null/undefined) for an empty Json column.
function toJson(value: unknown) {
  return value === undefined || value === null
    ? Prisma.JsonNull
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}
