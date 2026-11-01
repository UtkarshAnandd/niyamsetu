import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

const linkSchema = z.object({
  email: z.string().email(),
  institutionId: z.string().min(1),
});

// POST /api/users/link-institution (ADMIN)
// The user must log in again afterwards: the old JWT carries the old institutionId.
router.post("/link-institution", requireRole("ADMIN"), async (req, res) => {
  const { email, institutionId } = linkSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  if (user.role !== "INSTITUTION") {
    return res.status(400).json({ error: "Only INSTITUTION users can be linked" });
  }
  const institution = await prisma.institution.findUnique({ where: { id: institutionId } });
  if (!institution) {
    return res.status(404).json({ error: "Institution not found" });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { institutionId },
    select: { id: true, email: true, name: true, role: true, institutionId: true },
  });

  await audit(req.user!.userId, "UPDATE", "User", user.id,
    { institutionId: user.institutionId }, { institutionId });
  res.json({ user: updated });
});

export default router;
