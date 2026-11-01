import type { ApplicationStage } from "@prisma/client";
import type { AuthUser } from "../types/express";

// Which stage an application may move to next.
export const ALLOWED_TRANSITIONS: Record<ApplicationStage, ApplicationStage[]> = {
  SUBMITTED: ["SCRUTINY"],
  SCRUTINY: ["EXPERT_VISIT", "RETURNED"],
  EXPERT_VISIT: ["COMMITTEE", "RETURNED"],
  COMMITTEE: ["APPROVED", "RETURNED"],
  APPROVED: [],
  RETURNED: ["SUBMITTED"], // resubmission
};

// The expert visit can only be scheduled in these stages.
export const EXPERT_VISIT_STAGES: ApplicationStage[] = ["SCRUTINY", "EXPERT_VISIT"];

type AppOwnership = { institutionId: string; assignedOfficerId: string | null };

// Read access: ADMIN all, OFFICER assigned to them, INSTITUTION its own.
export function canViewApplication(user: AuthUser, app: AppOwnership): boolean {
  if (user.role === "ADMIN") return true;
  if (user.role === "OFFICER") return app.assignedOfficerId === user.userId;
  return app.institutionId === user.institutionId;
}

// Write access (stage, expert visit): ADMIN any, OFFICER only if assigned.
export function canChangeApplication(user: AuthUser, app: AppOwnership): boolean {
  if (user.role === "ADMIN") return true;
  return user.role === "OFFICER" && app.assignedOfficerId === user.userId;
}
