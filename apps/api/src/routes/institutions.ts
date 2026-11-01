import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const createInstitutionSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  state: z.string().min(1),
  city: z.string().min(1),
  type: z.string().min(1),
  studentIntake: z.number().int().positive(),
  facultyCount: z.number().int().nonnegative(),
  builtUpAreaSqm: z.number().int().nonnegative(),
  landAreaAcres: z.number().nonnegative(),
  labCount: z.number().int().nonnegative(),
  // Document metadata only (no file upload here).
  documents: z
    .array(
      z.object({
        docType: z.string().min(1),
        fileName: z.string().min(1),
        expiryDate: z.coerce.date().optional(),
      })
    )
    .optional(),
});

// POST /api/institutions (ADMIN)
router.post("/", requireRole("ADMIN"), async (req, res) => {
  const { documents = [], ...data } = createInstitutionSchema.parse(req.body);

  const institution = await prisma.institution.create({
    data: { ...data, documents: { create: documents } },
    include: { documents: true },
  });

  await audit(req.user!.userId, "CREATE", "Institution", institution.id, null, institution);
  res.status(201).json({ institution });
});

// GET /api/institutions (ADMIN, OFFICER: all; INSTITUTION: only its own)
router.get("/", async (req, res) => {
  const user = req.user!;
  if (user.role === "INSTITUTION" && !user.institutionId) {
    return res.json({ institutions: [] });
  }
  const institutions = await prisma.institution.findMany({
    where: user.role === "INSTITUTION" ? { id: user.institutionId! } : {},
    include: { documents: true },
    orderBy: { code: "asc" },
  });
  res.json({ institutions });
});

export default router;
