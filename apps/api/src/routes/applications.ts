import { Router } from "express";
import { z } from "zod";
import { ApplicationStage, type Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { requireAuth, requireRole } from "../middleware/auth";
import {
  ALLOWED_TRANSITIONS,
  EXPERT_VISIT_STAGES,
  canChangeApplication,
  canViewApplication,
} from "../services/workflow";

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  programme: z.string().min(1),
  academicYear: z.string().min(1),
  institutionId: z.string().optional(), // required for ADMIN, ignored for INSTITUTION
});
const stageSchema = z.object({
  toStage: z.enum(ApplicationStage),
  remark: z.string().optional(),
});
const assignSchema = z.object({ officerId: z.string().min(1) });
const expertVisitSchema = z.object({
  expertVisitDate: z.coerce.date(),
  expertNames: z.string().min(1),
});

// POST /api/applications (INSTITUTION for itself, or ADMIN)
router.post("/", requireRole("INSTITUTION", "ADMIN"), async (req, res) => {
  const user = req.user!;
  const body = createSchema.parse(req.body);

  const institutionId = user.role === "INSTITUTION" ? user.institutionId : body.institutionId;
  if (!institutionId) {
    return res.status(400).json({
      error: user.role === "INSTITUTION"
        ? "Your account is not linked to an institution"
        : "institutionId is required",
    });
  }
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) {
    return res.status(404).json({ error: "Institution not found" });
  }

  const application = await prisma.application.create({
    data: {
      institutionId,
      programme: body.programme,
      academicYear: body.academicYear,
      stageHistory: { create: { fromStage: null, toStage: "SUBMITTED", changedById: user.userId } },
    },
  });

  await audit(user.userId, "CREATE", "Application", application.id, null, application);
  res.status(201).json({ application });
});

// GET /api/applications (role-filtered)
router.get("/", async (req, res) => {
  const user = req.user!;
  let where: Prisma.ApplicationWhereInput = {};
  if (user.role === "OFFICER") where = { assignedOfficerId: user.userId };
  if (user.role === "INSTITUTION") where = { institutionId: user.institutionId ?? "__none__" };

  const applications = await prisma.application.findMany({
    where,
    include: {
      institution: { select: { id: true, code: true, name: true } },
      assignedOfficer: { select: { id: true, name: true, email: true } },
    },
    orderBy: { submittedAt: "desc" },
  });
  res.json({ applications });
});

// GET /api/applications/:id (with stage history)
router.get("/:id", async (req, res) => {
  const application = await prisma.application.findUnique({
    where: { id: req.params.id },
    include: {
      institution: true,
      assignedOfficer: { select: { id: true, name: true, email: true } },
      stageHistory: {
        orderBy: { changedAt: "asc" },
        include: { changedBy: { select: { id: true, name: true, role: true } } },
      },
    },
  });
  if (!application) {
    return res.status(404).json({ error: "Application not found" });
  }
  if (!canViewApplication(req.user!, application)) {
    return res.status(403).json({ error: "You cannot view this application" });
  }
  res.json({ application });
});

// PATCH /api/applications/:id/stage (OFFICER if assigned, ADMIN)
router.patch("/:id/stage", requireRole("OFFICER", "ADMIN"), async (req, res) => {
  const user = req.user!;
  const { toStage, remark } = stageSchema.parse(req.body);

  const app = await prisma.application.findUnique({ where: { id: String(req.params.id) } });
  if (!app) {
    return res.status(404).json({ error: "Application not found" });
  }
  if (!canChangeApplication(user, app)) {
    return res.status(403).json({ error: "Application is not assigned to you" });
  }
  const allowed = ALLOWED_TRANSITIONS[app.stage];
  if (!allowed.includes(toStage)) {
    return res.status(400).json({
      error: `Cannot move from ${app.stage} to ${toStage}`,
      allowed,
    });
  }

  // Stage change and its history row are saved together.
  const [application] = await prisma.$transaction([
    prisma.application.update({ where: { id: app.id }, data: { stage: toStage } }),
    prisma.applicationStageHistory.create({
      data: { applicationId: app.id, fromStage: app.stage, toStage, changedById: user.userId, remark },
    }),
  ]);

  await audit(user.userId, "STATUS_CHANGE", "Application", app.id, { stage: app.stage }, { stage: toStage, remark });
  res.json({ application });
});

// POST /api/applications/:id/assign (ADMIN)
router.post("/:id/assign", requireRole("ADMIN"), async (req, res) => {
  const { officerId } = assignSchema.parse(req.body);

  const app = await prisma.application.findUnique({ where: { id: String(req.params.id) } });
  if (!app) {
    return res.status(404).json({ error: "Application not found" });
  }
  const officer = await prisma.user.findUnique({ where: { id: officerId } });
  if (!officer || officer.role !== "OFFICER") {
    return res.status(400).json({ error: "officerId must belong to an OFFICER user" });
  }

  const application = await prisma.application.update({
    where: { id: app.id },
    data: { assignedOfficerId: officerId },
  });

  await audit(req.user!.userId, "UPDATE", "Application", app.id,
    { assignedOfficerId: app.assignedOfficerId }, { assignedOfficerId: officerId });
  res.json({ application });
});

// PATCH /api/applications/:id/expert-visit (OFFICER if assigned, ADMIN)
router.patch("/:id/expert-visit", requireRole("OFFICER", "ADMIN"), async (req, res) => {
  const user = req.user!;
  const { expertVisitDate, expertNames } = expertVisitSchema.parse(req.body);

  const app = await prisma.application.findUnique({ where: { id: String(req.params.id) } });
  if (!app) {
    return res.status(404).json({ error: "Application not found" });
  }
  if (!canChangeApplication(user, app)) {
    return res.status(403).json({ error: "Application is not assigned to you" });
  }
  if (!EXPERT_VISIT_STAGES.includes(app.stage)) {
    return res.status(400).json({
      error: `Expert visit can only be set in ${EXPERT_VISIT_STAGES.join(" or ")}`,
    });
  }

  const application = await prisma.application.update({
    where: { id: app.id },
    data: { expertVisitDate, expertNames },
  });

  await audit(user.userId, "UPDATE", "Application", app.id,
    { expertVisitDate: app.expertVisitDate, expertNames: app.expertNames },
    { expertVisitDate, expertNames });
  res.json({ application });
});

export default router;
