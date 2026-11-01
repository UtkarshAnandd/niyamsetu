import { Router } from "express";
import { z } from "zod";
import { DeficiencyStatus, type Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { canChangeApplication } from "../services/workflow";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const listQuerySchema = z.object({
  applicationId: z.string().optional(),
  status: z.enum(DeficiencyStatus).optional(),
});
const assignSchema = z
  .object({
    ownerId: z.string().min(1).optional(),
    dueDate: z.coerce.date().optional(),
  })
  .refine((b) => b.ownerId || b.dueDate, { message: "Send ownerId and/or dueDate" });

// GET /api/deficiencies?applicationId=&status=
// INSTITUTION: own institution; OFFICER: on applications assigned to them; ADMIN: all.
router.get("/", async (req, res) => {
  const user = req.user!;
  const { applicationId, status } = listQuerySchema.parse(req.query);

  let appFilter: Prisma.ApplicationWhereInput = {};
  if (user.role === "OFFICER") appFilter = { assignedOfficerId: user.userId };
  if (user.role === "INSTITUTION") appFilter = { institutionId: user.institutionId ?? "__none__" };

  const deficiencies = await prisma.deficiency.findMany({
    where: { application: appFilter, applicationId, status },
    include: {
      owner: { select: { id: true, name: true, email: true, role: true } },
      application: { select: { id: true, programme: true, institution: { select: { code: true, name: true } } } },
      ruleCheck: { select: { rule: { select: { code: true, version: true } } } },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
  });
  res.json({ deficiencies });
});

// PATCH /api/deficiencies/:id/assign (assigned OFFICER, ADMIN)
// Owner must be an INSTITUTION user of that institution, or the application's assigned OFFICER.
router.patch("/:id/assign", requireRole("OFFICER", "ADMIN"), async (req, res) => {
  const user = req.user!;
  const { ownerId, dueDate } = assignSchema.parse(req.body);

  const deficiency = await prisma.deficiency.findUnique({
    where: { id: String(req.params.id) },
    include: { application: true },
  });
  if (!deficiency) {
    return res.status(404).json({ error: "Deficiency not found" });
  }
  const app = deficiency.application;
  if (!canChangeApplication(user, app)) {
    return res.status(403).json({ error: "Application is not assigned to you" });
  }
  if (dueDate && dueDate <= new Date()) {
    return res.status(400).json({ error: "dueDate must be in the future" });
  }
  if (ownerId) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId } });
    const isInstitutionUser = owner?.role === "INSTITUTION" && owner.institutionId === app.institutionId;
    const isAssignedOfficer = owner?.role === "OFFICER" && owner.id === app.assignedOfficerId;
    if (!isInstitutionUser && !isAssignedOfficer) {
      return res.status(400).json({
        error: "Owner must be an INSTITUTION user of this institution or the assigned OFFICER",
      });
    }
  }

  const updated = await prisma.deficiency.update({
    where: { id: deficiency.id },
    data: { ownerId, dueDate },
  });

  await audit(user.userId, "UPDATE", "Deficiency", deficiency.id,
    { ownerId: deficiency.ownerId, dueDate: deficiency.dueDate },
    { ownerId: updated.ownerId, dueDate: updated.dueDate });
  res.json({ deficiency: updated });
});

export default router;
