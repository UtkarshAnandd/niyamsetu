import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { DeficiencyStatus, type Prisma } from "@prisma/client";
import { prisma } from "../db";
import { idParams, limitField } from "../services/validation";
import { audit } from "../services/audit";
import { alertAdmins, createAlert } from "../services/alerts";
import { defaultDueDate } from "../services/rules";
import { applicationScope, canChangeApplication, canViewApplication } from "../services/workflow";
import { requireAuth, requireRole } from "../middleware/auth";
import { cleanFileName, evidenceUpload } from "../middleware/upload";

const router = Router();
router.use(requireAuth);

const listQuerySchema = z.object({
  applicationId: z.string().optional(),
  status: z.enum(DeficiencyStatus).optional(),
  limit: limitField,
});
const assignSchema = z
  .object({
    ownerId: z.string().min(1).optional(),
    dueDate: z.coerce.date().optional(),
  })
  .refine((b) => b.ownerId || b.dueDate, { message: "Send ownerId and/or dueDate" });

// GET /api/deficiencies?applicationId=&status=&limit=
// INSTITUTION: own institution; OFFICER: on applications assigned to them; ADMIN: all.
router.get("/", async (req, res) => {
  const { applicationId, status, limit } = listQuerySchema.parse(req.query);
  const where: Prisma.DeficiencyWhereInput = { application: applicationScope(req.user!), applicationId, status };

  const [total, deficiencies] = await Promise.all([
    prisma.deficiency.count({ where }),
    prisma.deficiency.findMany({
      where,
      include: {
        owner: { select: { id: true, name: true, email: true, role: true } },
        application: { select: { id: true, programme: true, institution: { select: { code: true, name: true } } } },
        ruleCheck: { select: { rule: { select: { code: true, version: true } } } },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: limit,
    }),
  ]);
  res.json({ total, deficiencies });
});

// PATCH /api/deficiencies/:id/assign (assigned OFFICER, ADMIN)
// Owner must be an INSTITUTION user of that institution, or the application's assigned OFFICER.
router.patch("/:id/assign", requireRole("OFFICER", "ADMIN"), async (req, res) => {
  const user = req.user!;
  const { ownerId, dueDate } = assignSchema.parse(req.body);

  const deficiency = await prisma.deficiency.findUnique({
    where: { id: idParams.parse(req.params).id },
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

  // A new deadline on an OVERDUE deficiency reopens it, so the engine can alert again.
  const reopen = dueDate && deficiency.status === "OVERDUE";
  const updated = await prisma.deficiency.update({
    where: { id: deficiency.id },
    data: { ownerId, dueDate, ...(reopen && { status: "OPEN", escalatedAt: null }) },
  });

  await audit(user.userId, reopen ? "STATUS_CHANGE" : "UPDATE", "Deficiency", deficiency.id,
    { ownerId: deficiency.ownerId, dueDate: deficiency.dueDate, status: deficiency.status, escalatedAt: deficiency.escalatedAt },
    { ownerId: updated.ownerId, dueDate: updated.dueDate, status: updated.status, escalatedAt: updated.escalatedAt });
  res.json({ deficiency: updated });
});

// GET /api/deficiencies/:id – with rule, application, owner and evidence list
router.get("/:id", async (req, res) => {
  const deficiency = await prisma.deficiency.findUnique({
    where: { id: idParams.parse(req.params).id },
    include: {
      ruleCheck: { include: { rule: true } },
      application: {
        include: {
          institution: { select: { id: true, code: true, name: true } },
          assignedOfficer: { select: { id: true, name: true, email: true } },
        },
      },
      owner: { select: { id: true, name: true, email: true, role: true } },
      evidence: {
        orderBy: { uploadedAt: "desc" },
        include: {
          uploadedBy: { select: { id: true, name: true } },
          verifiedBy: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!deficiency) {
    return res.status(404).json({ error: "Deficiency not found" });
  }
  if (!canViewApplication(req.user!, deficiency.application)) {
    return res.status(403).json({ error: "You cannot view this deficiency" });
  }
  res.json({ deficiency });
});

// Runs before multer so a forbidden user never writes a file to disk.
// Allowed: the deficiency owner, or an INSTITUTION user of that institution.
async function canUploadEvidence(req: Request, res: Response, next: NextFunction) {
  const user = req.user!;
  const deficiency = await prisma.deficiency.findUnique({
    where: { id: idParams.parse(req.params).id },
    include: { application: { include: { institution: true } } },
  });
  if (!deficiency) {
    return res.status(404).json({ error: "Deficiency not found" });
  }
  const isOwner = deficiency.ownerId === user.userId;
  const isInstitutionUser =
    user.role === "INSTITUTION" && user.institutionId === deficiency.application.institutionId;
  if (!isOwner && !isInstitutionUser) {
    return res.status(403).json({ error: "You cannot upload evidence for this deficiency" });
  }
  if (deficiency.status === "VERIFIED") {
    return res.status(400).json({ error: "Deficiency is already verified" });
  }
  res.locals.deficiency = deficiency;
  next();
}

const evidenceBodySchema = z.object({ note: z.string().optional() });

// POST /api/deficiencies/:id/evidence (multipart: file, note?)
router.post("/:id/evidence", canUploadEvidence, evidenceUpload.single("file"), async (req, res) => {
  const user = req.user!;
  const deficiency = res.locals.deficiency as Prisma.DeficiencyGetPayload<{
    include: { application: { include: { institution: true } } };
  }>;
  if (!req.file) {
    return res.status(400).json({ error: "File is required (form field name: file)" });
  }
  const { note } = evidenceBodySchema.parse(req.body ?? {});

  const [evidence, updated] = await prisma.$transaction([
    prisma.evidence.create({
      data: {
        deficiencyId: deficiency.id,
        uploadedById: user.userId,
        fileName: cleanFileName(req.file.originalname),
        filePath: req.file.filename, // relative to apps/api/uploads/
        mimeType: req.file.mimetype,
        note,
      },
    }),
    prisma.deficiency.update({
      where: { id: deficiency.id },
      data: { status: "EVIDENCE_SUBMITTED" },
    }),
  ]);

  await audit(user.userId, "CREATE", "Evidence", evidence.id, null, evidence);
  await audit(user.userId, "STATUS_CHANGE", "Deficiency", deficiency.id,
    { status: deficiency.status }, { status: updated.status });

  // Alert the assigned officer; if there is none, alert every ADMIN.
  const app = deficiency.application;
  const message = `Evidence uploaded for ${app.institution.code}: ${deficiency.requirement}`;
  let alertedRole: "OFFICER" | "ADMIN";
  if (app.assignedOfficerId) {
    await createAlert(app.assignedOfficerId, "STATUS_CHANGE", message, deficiency.id, `EVIDENCE:${evidence.id}`);
    alertedRole = "OFFICER";
  } else {
    await alertAdmins("STATUS_CHANGE", message, deficiency.id, `EVIDENCE:${evidence.id}`);
    alertedRole = "ADMIN";
  }

  res.status(201).json({ evidence, deficiency: updated, alertedRole });
});

const verifySchema = z
  .object({
    decision: z.enum(["VERIFIED", "REJECTED"]),
    remark: z.string().optional(),
  })
  .refine((b) => b.decision === "VERIFIED" || (b.remark && b.remark.trim()), {
    message: "remark is required when rejecting",
    path: ["remark"],
  });

// PATCH /api/deficiencies/:id/verify (assigned OFFICER, ADMIN)
// Reviews the newest evidence. REJECTED gives a new dueDate and resets escalation.
router.patch("/:id/verify", requireRole("OFFICER", "ADMIN"), async (req, res) => {
  const user = req.user!;
  const { decision, remark } = verifySchema.parse(req.body);

  const deficiency = await prisma.deficiency.findUnique({
    where: { id: idParams.parse(req.params).id },
    include: {
      application: { include: { institution: true } },
      evidence: { orderBy: { uploadedAt: "desc" }, take: 1 },
    },
  });
  if (!deficiency) {
    return res.status(404).json({ error: "Deficiency not found" });
  }
  if (!canChangeApplication(user, deficiency.application)) {
    return res.status(403).json({ error: "Application is not assigned to you" });
  }
  const evidence = deficiency.evidence[0];
  if (deficiency.status !== "EVIDENCE_SUBMITTED" || !evidence) {
    return res.status(400).json({
      error: `Can only verify when evidence is submitted (status is ${deficiency.status})`,
    });
  }

  const now = new Date();
  const evidenceData =
    decision === "VERIFIED"
      ? { verifiedById: user.userId, verifiedAt: now, reviewRemark: remark ?? null }
      : { reviewRemark: remark ?? null };
  const deficiencyData =
    decision === "VERIFIED"
      ? { status: "VERIFIED" as const }
      : { status: "REJECTED" as const, dueDate: defaultDueDate(), escalatedAt: null };

  const [updatedEvidence, updated] = await prisma.$transaction([
    prisma.evidence.update({ where: { id: evidence.id }, data: evidenceData }),
    prisma.deficiency.update({ where: { id: deficiency.id }, data: deficiencyData }),
  ]);

  await audit(user.userId, "UPDATE", "Evidence", evidence.id,
    { verifiedById: evidence.verifiedById, verifiedAt: evidence.verifiedAt, reviewRemark: evidence.reviewRemark },
    { verifiedById: updatedEvidence.verifiedById, verifiedAt: updatedEvidence.verifiedAt, reviewRemark: updatedEvidence.reviewRemark });
  await audit(user.userId, "STATUS_CHANGE", "Deficiency", deficiency.id,
    { status: deficiency.status, dueDate: deficiency.dueDate, escalatedAt: deficiency.escalatedAt },
    { status: updated.status, dueDate: updated.dueDate, escalatedAt: updated.escalatedAt, remark });

  // Tell the owner either way.
  let ownerAlerted = false;
  if (deficiency.ownerId) {
    const message =
      decision === "VERIFIED"
        ? `Evidence verified for ${deficiency.application.institution.code}: ${deficiency.requirement}${remark ? ` – ${remark}` : ""}`
        : `Evidence rejected for ${deficiency.application.institution.code}: ${remark}. Re-upload by ${updated.dueDate?.toISOString()}`;
    await createAlert(deficiency.ownerId, "STATUS_CHANGE", message, deficiency.id, `${decision}:${evidence.id}`);
    ownerAlerted = true;
  }

  res.json({ deficiency: updated, evidence: updatedEvidence, ownerAlerted });
});

export default router;
