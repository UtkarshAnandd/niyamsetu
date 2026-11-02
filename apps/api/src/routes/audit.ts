import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { idParams, limitField, limitQuery } from "../services/validation";
import { requireAuth } from "../middleware/auth";
import { applicationScope, canViewApplication } from "../services/workflow";
import type { AuthUser } from "../types/express";

const auditQuerySchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  limit: limitField,
});

const withActor = { actor: { select: { id: true, name: true, role: true } } } as const;
type AuditRow = Prisma.AuditLogGetPayload<{ include: typeof withActor }>;

// Shape sent to the browser. A null actor means the system (seed, deadline engine, alerts).
function present(row: AuditRow) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorId: row.actorId,
    actorName: row.actor?.name ?? "System",
    actorRole: row.actor?.role ?? null,
    before: row.before,
    after: row.after,
  };
}

// Audit rows about one or more applications, their rule checks, deficiencies and evidence.
async function applicationEntities(appIds: string[]): Promise<Prisma.AuditLogWhereInput[]> {
  const deficiencies = await prisma.deficiency.findMany({
    where: { applicationId: { in: appIds } },
    select: { id: true },
  });
  const defIds = deficiencies.map((d) => d.id);
  const evidence = await prisma.evidence.findMany({
    where: { deficiencyId: { in: defIds } },
    select: { id: true },
  });
  return [
    { entityType: "Application", entityId: { in: appIds } },
    { entityType: "RuleCheck", entityId: { in: appIds } }, // a check run is logged against the application id
    { entityType: "Deficiency", entityId: { in: defIds } },
    { entityType: "Evidence", entityId: { in: evidence.map((e) => e.id) } },
  ];
}

// What a non-admin may see: everything about their applications, the institutions
// behind them, their own user record and alerts sent to them. null = no restriction.
async function visibleTo(user: AuthUser): Promise<Prisma.AuditLogWhereInput | null> {
  if (user.role === "ADMIN") return null;

  const apps = await prisma.application.findMany({
    where: applicationScope(user),
    select: { id: true, institutionId: true },
  });
  const institutionIds = new Set(apps.map((a) => a.institutionId));
  if (user.institutionId) institutionIds.add(user.institutionId);
  const alerts = await prisma.alert.findMany({ where: { userId: user.userId }, select: { id: true } });

  return {
    OR: [
      ...(await applicationEntities(apps.map((a) => a.id))),
      { entityType: "Institution", entityId: { in: [...institutionIds] } },
      { entityType: "User", entityId: user.userId },
      { entityType: "Alert", entityId: { in: alerts.map((a) => a.id) } },
    ],
  };
}

// ---------- /api/audit ----------

export const auditRouter = Router();
auditRouter.use(requireAuth);

// GET /api/audit?entityType=&entityId=&limit= – newest first
auditRouter.get("/", async (req, res) => {
  const { entityType, entityId, limit } = auditQuerySchema.parse(req.query);
  const scope = await visibleTo(req.user!);
  const where: Prisma.AuditLogWhereInput = {
    AND: [scope ?? {}, { entityType, entityId }],
  };

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: withActor, orderBy: { createdAt: "desc" }, take: limit }),
  ]);
  res.json({ total, audit: rows.map(present) });
});

// ---------- /api/applications/:id/audit ----------

export const applicationAuditRouter = Router();
applicationAuditRouter.use(requireAuth);

// GET /api/applications/:id/audit?limit= – the application, its rule checks,
// deficiencies and evidence, newest first. Alert rows are left out on purpose.
applicationAuditRouter.get("/:id/audit", async (req, res) => {
  const { limit } = limitQuery.parse(req.query);
  const app = await prisma.application.findUnique({ where: { id: idParams.parse(req.params).id } });
  if (!app) {
    return res.status(404).json({ error: "Application not found" });
  }
  if (!canViewApplication(req.user!, app)) {
    return res.status(403).json({ error: "You cannot view this application" });
  }

  const where: Prisma.AuditLogWhereInput = { OR: await applicationEntities([app.id]) };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, include: withActor, orderBy: { createdAt: "desc" }, take: limit }),
  ]);
  res.json({ applicationId: app.id, total, audit: rows.map(present) });
});
