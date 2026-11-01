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

// Sends the same alert to every ADMIN. Each gets its own dedupKey: "<baseKey>:<adminId>".
export async function alertAdmins(
  type: AlertType,
  message: string,
  deficiencyId: string | null,
  baseKey: string
) {
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  for (const admin of admins) {
    await createAlert(admin.id, type, message, deficiencyId, `${baseKey}:${admin.id}`);
  }
}
