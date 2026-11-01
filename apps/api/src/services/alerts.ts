import { Prisma, type AlertType } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "./audit";

// Creates an in-app alert unless one with the same dedupKey already exists.
// Returns the new alert, or null if it was a duplicate.
export async function createAlert(
  userId: string,
  type: AlertType,
  message: string,
  deficiencyId: string | null,
  dedupKey: string
) {
  const existing = await prisma.alert.findUnique({ where: { dedupKey } });
  if (existing) return null;

  try {
    const alert = await prisma.alert.create({
      data: { userId, type, message, deficiencyId, dedupKey },
    });
    // actorId null = created by the system.
    await audit(null, "CREATE", "Alert", alert.id, null, alert);
    return alert;
  } catch (e) {
    // Another request created the same dedupKey at the same moment.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null;
    throw e;
  }
}

// Alerts the first non-null user in the list; if there is none, alerts every ADMIN.
// Returns the ids of the users that got a NEW alert (empty if it was a duplicate).
export async function alertWithFallback(
  candidates: (string | null | undefined)[],
  type: AlertType,
  message: string,
  deficiencyId: string | null,
  dedupKey: string
): Promise<string[]> {
  const userId = candidates.find((id) => id);
  if (userId) {
    const alert = await createAlert(userId, type, message, deficiencyId, dedupKey);
    return alert ? [userId] : [];
  }
  return alertAdmins(type, message, deficiencyId, dedupKey);
}

// Sends the same alert to every ADMIN. Each gets its own dedupKey: "<baseKey>:<adminId>".
// Returns the ids of the admins that got a NEW alert.
export async function alertAdmins(
  type: AlertType,
  message: string,
  deficiencyId: string | null,
  baseKey: string
) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  const alerted: string[] = [];
  for (const admin of admins) {
    const alert = await createAlert(admin.id, type, message, deficiencyId, `${baseKey}:${admin.id}`);
    if (alert) alerted.push(admin.id);
  }
  return alerted;
}
