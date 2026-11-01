import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth";
import { runDeadlineCheck } from "../jobs/deadlines";

const router = Router();
router.use(requireAuth, requireRole("ADMIN"));

// POST /api/admin/run-deadline-check – same logic as the cron job, on demand.
router.post("/run-deadline-check", async (_req, res) => {
  res.json(await runDeadlineCheck());
});

export default router;
