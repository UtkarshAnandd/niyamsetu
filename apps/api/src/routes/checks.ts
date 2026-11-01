import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { evaluate } from "../services/rules";
import { canViewApplication } from "../services/workflow";
import { requireAuth } from "../middleware/auth";

// Mounted at /api/applications next to the applications router.
const router = Router();
router.use(requireAuth);

const checkSchema = z.object({ asOf: z.coerce.date().optional() });

// POST /api/applications/:id/check
// INSTITUTION (own app, pre-check), OFFICER (assigned), ADMIN. Only ADMIN may pass asOf.
router.post("/:id/check", async (req, res) => {
  const user = req.user!;
  const { asOf } = checkSchema.parse(req.body ?? {});

  const app = await prisma.application.findUnique({ where: { id: req.params.id } });
  if (!app) {
    return res.status(404).json({ error: "Application not found" });
  }
  if (!canViewApplication(user, app)) {
    return res.status(403).json({ error: "You cannot check this application" });
  }
  if (asOf && user.role !== "ADMIN") {
    return res.status(403).json({ error: "Only ADMIN can check as of another date" });
  }

  const result = await evaluate(app.id, asOf);

  await audit(user.userId, "CREATE", "RuleCheck", app.id, null, {
    asOf: result.asOf,
    preview: result.preview,
    summary: result.results.map((r) => `${r.code} v${r.version}: ${r.passed ? "PASS" : "FAIL"}`),
    deficienciesCreated: result.deficienciesCreated.length,
  });
  for (const d of result.deficienciesCreated) {
    await audit(user.userId, "CREATE", "Deficiency", d.id, null, d);
  }

  res.json(result);
});

// GET /api/applications/:id/checks – latest result per rule code
router.get("/:id/checks", async (req, res) => {
  const app = await prisma.application.findUnique({ where: { id: req.params.id } });
  if (!app) {
    return res.status(404).json({ error: "Application not found" });
  }
  if (!canViewApplication(req.user!, app)) {
    return res.status(403).json({ error: "You cannot view this application" });
  }

  const checks = await prisma.ruleCheck.findMany({
    where: { applicationId: app.id },
    include: { rule: true },
    orderBy: { checkedAt: "desc" },
  });
  // Newest first, so the first one seen for each code is the latest.
  const latest = new Map<string, (typeof checks)[number]>();
  for (const c of checks) {
    if (!latest.has(c.rule.code)) latest.set(c.rule.code, c);
  }

  res.json({
    applicationId: app.id,
    checks: [...latest.values()].map((c) => ({
      code: c.rule.code,
      version: c.rule.version,
      source: c.rule.source,
      passed: c.passed,
      actual: c.actualValue,
      expected: c.expectedValue,
      checkedAt: c.checkedAt,
    })),
  });
});

export default router;
