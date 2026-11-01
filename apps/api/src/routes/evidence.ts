import path from "path";
import { Router } from "express";
import { prisma } from "../db";
import { canViewApplication } from "../services/workflow";
import { requireAuth } from "../middleware/auth";
import { UPLOAD_DIR } from "../middleware/upload";

const router = Router();
router.use(requireAuth);

// GET /api/evidence/:id/file – same visibility as the deficiency's application.
router.get("/:id/file", async (req, res) => {
  const evidence = await prisma.evidence.findUnique({
    where: { id: req.params.id },
    include: { deficiency: { include: { application: true } } },
  });
  if (!evidence) {
    return res.status(404).json({ error: "Evidence not found" });
  }
  if (!canViewApplication(req.user!, evidence.deficiency.application)) {
    return res.status(403).json({ error: "You cannot view this evidence" });
  }

  // basename() keeps the path inside the uploads folder.
  res.sendFile(path.join(UPLOAD_DIR, path.basename(evidence.filePath)), {
    headers: {
      "Content-Type": evidence.mimeType,
      "Content-Disposition": `inline; filename="${evidence.fileName}"`,
    },
  });
});

export default router;
