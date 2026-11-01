import cron from "node-cron";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { alertWithFallback } from "../services/alerts";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// DEMO_MODE=true: minutes instead of days.
function windows() {
  const demo = process.env.DEMO_MODE === "true";
  return {
    dueSoonMs: demo ? 3 * MINUTE : 2 * DAY,
    graceMs: demo ? 2 * MINUTE : 1 * DAY, // wait this long after the deadline before escalating
  };
}

type Detail = {
  kind: "DUE_SOON" | "OVERDUE" | "ESCALATION" | "EVC";
  deficiencyId?: string;
  applicationId?: string;
  alertedUserIds: string[];
};

const withContext = {
  owner: true,
  application: { include: { institution: true, assignedOfficer: true } },
} as const;

// One pass of the deadline engine. Safe to run any number of times:
// every alert has a dedupKey, and status changes only apply once.
export async function runDeadlineCheck(now = new Date()) {
  const { dueSoonMs, graceMs } = windows();
  const summary = { dueSoon: 0, overdue: 0, escalated: 0, evcReminders: 0 };
  const details: Detail[] = [];

  // 1. DUE_SOON: deadline is within the window.
  const dueSoon = await prisma.deficiency.findMany({
    where: {
      status: { in: ["OPEN", "REJECTED"] },
      dueDate: { gt: now, lte: new Date(now.getTime() + dueSoonMs) },
    },
    include: withContext,
  });
  for (const d of dueSoon) {
    const due = d.dueDate!;
    const alerted = await alertWithFallback(
      [d.ownerId, d.application.assignedOfficerId],
      "DUE_SOON",
      `Due soon (${due.toISOString()}): ${d.application.institution.code} – ${d.requirement}`,
      d.id,
      `DUE_SOON:${d.id}:${due.getTime()}`
    );
    if (alerted.length) {
      summary.dueSoon++;
      details.push({ kind: "DUE_SOON", deficiencyId: d.id, alertedUserIds: alerted });
    }
  }

  // 2. OVERDUE: deadline has passed. Mark the deficiency OVERDUE and tell the owner.
  const overdue = await prisma.deficiency.findMany({
    where: { status: { in: ["OPEN", "REJECTED"] }, dueDate: { lt: now } },
    include: withContext,
  });
  for (const d of overdue) {
    const due = d.dueDate!;
    // Only change it if nobody else changed the status in the meantime.
    const { count } = await prisma.deficiency.updateMany({
      where: { id: d.id, status: d.status },
      data: { status: "OVERDUE" },
    });
    if (count === 0) continue;
    await audit(null, "STATUS_CHANGE", "Deficiency", d.id,
      { status: d.status }, { status: "OVERDUE", reason: "deadline engine" });

    const alerted = await alertWithFallback(
      [d.ownerId, d.application.assignedOfficerId],
      "OVERDUE",
      `Overdue since ${due.toISOString()}: ${d.application.institution.code} – ${d.requirement}`,
      d.id,
      `OVERDUE:${d.id}:${due.getTime()}`
    );
    summary.overdue++;
    details.push({ kind: "OVERDUE", deficiencyId: d.id, alertedUserIds: alerted });
  }

  // 3. ESCALATION: still overdue after the grace period. One level up, once per deadline.
  const toEscalate = await prisma.deficiency.findMany({
    where: {
      status: "OVERDUE",
      escalatedAt: null,
      dueDate: { lt: new Date(now.getTime() - graceMs) },
    },
    include: withContext,
  });
  for (const d of toEscalate) {
    const due = d.dueDate!;
    // Claim it first so two runs can never escalate the same deficiency.
    const { count } = await prisma.deficiency.updateMany({
      where: { id: d.id, escalatedAt: null },
      data: { escalatedAt: now },
    });
    if (count === 0) continue;
    await audit(null, "UPDATE", "Deficiency", d.id,
      { escalatedAt: null }, { escalatedAt: now, reason: "escalated by deadline engine" });

    // Owner's manager, else the assigned officer's manager, else every ADMIN.
    const alerted = await alertWithFallback(
      [d.owner?.managerId, d.application.assignedOfficer?.managerId],
      "ESCALATION",
      `Escalation: ${d.application.institution.code} deficiency overdue since ${due.toISOString()}, ` +
        `owner ${d.owner?.name ?? "unassigned"} – ${d.requirement}`,
      d.id,
      `ESCALATION:${d.id}:${due.getTime()}`
    );
    summary.escalated++;
    details.push({ kind: "ESCALATION", deficiencyId: d.id, alertedUserIds: alerted });
  }

  // 4. Expert visit (EVC) reminder for the assigned officer.
  const visits = await prisma.application.findMany({
    where: {
      stage: "EXPERT_VISIT",
      expertVisitDate: { gt: now, lte: new Date(now.getTime() + dueSoonMs) },
    },
    include: { institution: true },
  });
  for (const app of visits) {
    const visit = app.expertVisitDate!;
    const alerted = await alertWithFallback(
      [app.assignedOfficerId],
      "DUE_SOON",
      `Expert visit for ${app.institution.code} (${app.programme}) at ${visit.toISOString()}`,
      null,
      `EVC:${app.id}:${visit.getTime()}`
    );
    if (alerted.length) {
      summary.evcReminders++;
      details.push({ kind: "EVC", applicationId: app.id, alertedUserIds: alerted });
    }
  }

  return { ranAt: now, ...summary, details };
}

// Runs the check every minute. A slow run is never overlapped by the next one.
export function startDeadlineCron() {
  let running = false;
  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      const { ranAt, dueSoon, overdue, escalated, evcReminders } = await runDeadlineCheck();
      console.log(`[cron] deadline check ${ranAt.toISOString()}`,
        JSON.stringify({ dueSoon, overdue, escalated, evcReminders }));
    } catch (e) {
      console.error("[cron] deadline check failed", e);
    } finally {
      running = false;
    }
  });
  console.log("[cron] deadline check scheduled every minute");
}
