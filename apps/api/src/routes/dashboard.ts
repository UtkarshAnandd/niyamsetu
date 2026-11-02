import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { requireAuth, requireRole } from "../middleware/auth";
import { ALL_STAGES, applicationScope } from "../services/workflow";
import { RULE_CODES } from "../services/rules";
import { windows } from "../jobs/deadlines";
import { limitQuery } from "../services/validation";

// Every number here is counted live from the database, filtered by role.
const router = Router();
router.use(requireAuth);

// "Open" = anything not yet VERIFIED.
const notVerified: Prisma.DeficiencyWhereInput = { status: { not: "VERIFIED" } };

// Overdue = marked OVERDUE, or past due but not yet marked by the deadline engine.
const overdueWhere = (now: Date): Prisma.DeficiencyWhereInput => ({
  OR: [
    { status: "OVERDUE" },
    { status: { in: ["OPEN", "REJECTED"] }, dueDate: { lt: now } },
  ],
});

async function countByStage(where: Prisma.ApplicationWhereInput) {
  const groups = await prisma.application.groupBy({ by: ["stage"], where, _count: { _all: true } });
  return ALL_STAGES.map((stage) => ({
    stage,
    count: groups.find((g) => g.stage === stage)?._count._all ?? 0,
  }));
}

// GET /api/dashboard/summary
router.get("/summary", async (req, res) => {
  const scope = applicationScope(req.user!);
  const inScope: Prisma.DeficiencyWhereInput = { application: scope };
  const now = new Date();
  const dueSoonEnd = new Date(now.getTime() + windows().dueSoonMs);

  const [applications, byStage, openDeficiencies, dueSoon, overdue, escalated, unassignedDeficiencies] =
    await Promise.all([
      prisma.application.count({ where: scope }),
      countByStage(scope),
      prisma.deficiency.count({ where: { ...inScope, ...notVerified } }),
      prisma.deficiency.count({
        where: { ...inScope, status: { in: ["OPEN", "REJECTED"] }, dueDate: { gt: now, lte: dueSoonEnd } },
      }),
      prisma.deficiency.count({ where: { AND: [inScope, overdueWhere(now)] } }),
      prisma.deficiency.count({ where: { ...inScope, ...notVerified, escalatedAt: { not: null } } }),
      prisma.deficiency.count({ where: { ...inScope, ...notVerified, ownerId: null } }),
    ]);

  res.json({
    generatedAt: now,
    applications,
    byStage: Object.fromEntries(byStage.map((s) => [s.stage, s.count])),
    openDeficiencies,
    dueSoon,
    overdue,
    escalated,
    unassignedDeficiencies,
  });
});

// GET /api/dashboard/by-status – counts per stage (pie chart)
router.get("/by-status", async (req, res) => {
  res.json({ byStatus: await countByStage(applicationScope(req.user!)) });
});

// GET /api/dashboard/workload (ADMIN) – per officer
router.get("/workload", requireRole("ADMIN"), async (_req, res) => {
  const now = new Date();
  const officers = await prisma.user.findMany({
    where: { role: "OFFICER" },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });

  const workload = await Promise.all(
    officers.map(async (officer) => {
      const onTheirApps: Prisma.DeficiencyWhereInput = { application: { assignedOfficerId: officer.id } };
      const [assignedApplications, openDeficiencies, overdueDeficiencies] = await Promise.all([
        prisma.application.count({ where: { assignedOfficerId: officer.id } }),
        prisma.deficiency.count({ where: { ...onTheirApps, ...notVerified } }),
        prisma.deficiency.count({ where: { AND: [onTheirApps, overdueWhere(now)] } }),
      ]);
      return { officer, assignedApplications, openDeficiencies, overdueDeficiencies };
    })
  );
  res.json({ workload });
});

// GET /api/dashboard/deficiencies-by-rule – total and open per rule code (bar chart)
router.get("/deficiencies-by-rule", async (req, res) => {
  const deficiencies = await prisma.deficiency.findMany({
    where: { application: applicationScope(req.user!) },
    select: { status: true, ruleCheck: { select: { rule: { select: { code: true } } } } },
  });

  const byRule = RULE_CODES.map((code) => {
    const forCode = deficiencies.filter((d) => d.ruleCheck?.rule.code === code);
    return { code, total: forCode.length, open: forCode.filter((d) => d.status !== "VERIFIED").length };
  });
  res.json({ byRule });
});

// GET /api/dashboard/overdue?limit= – overdue deficiencies, most overdue first
router.get("/overdue", async (req, res) => {
  const { limit } = limitQuery.parse(req.query);
  const now = new Date();
  const where: Prisma.DeficiencyWhereInput = {
    AND: [{ application: applicationScope(req.user!) }, overdueWhere(now)],
  };

  const [total, rows] = await Promise.all([
    prisma.deficiency.count({ where }),
    prisma.deficiency.findMany({
      where,
      include: {
        application: {
          select: { id: true, programme: true, institution: { select: { code: true, name: true } } },
        },
        owner: { select: { id: true, name: true, email: true, role: true } },
        ruleCheck: { select: { rule: { select: { code: true, version: true } } } },
      },
      orderBy: { dueDate: "asc" },
      take: limit,
    }),
  ]);

  const overdue = rows.map((d) => {
    const msOverdue = now.getTime() - d.dueDate!.getTime();
    return {
      id: d.id,
      requirement: d.requirement,
      status: d.status,
      rule: d.ruleCheck ? `${d.ruleCheck.rule.code} v${d.ruleCheck.rule.version}` : null,
      application: d.application,
      owner: d.owner,
      dueDate: d.dueDate,
      hoursOverdue: Math.round((msOverdue / 3_600_000) * 10) / 10,
      minutesOverdue: Math.floor(msOverdue / 60_000),
      escalated: d.escalatedAt !== null,
      escalatedAt: d.escalatedAt,
    };
  });
  res.json({ total, overdue });
});

export default router;
