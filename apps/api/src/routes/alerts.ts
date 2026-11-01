import { Router } from "express";
import { z } from "zod";
import { AlertType } from "@prisma/client";
import { prisma } from "../db";
import { requireAuth } from "../middleware/auth";

// Read receipts are not audited: they are not regulatory actions.
const router = Router();
router.use(requireAuth);

const listQuerySchema = z.object({ unread: z.enum(["true", "false"]).optional() });
const historyQuerySchema = z.object({
  type: z.enum(AlertType).optional(),
  userId: z.string().optional(),
});

const deficiencySummary = {
  select: { id: true, requirement: true, status: true, applicationId: true },
} as const;

// GET /api/alerts?unread=true – the current user's alerts
router.get("/", async (req, res) => {
  const { unread } = listQuerySchema.parse(req.query);
  const alerts = await prisma.alert.findMany({
    where: { userId: req.user!.userId, ...(unread === "true" && { isRead: false }) },
    include: { deficiency: deficiencySummary },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const unreadCount = await prisma.alert.count({ where: { userId: req.user!.userId, isRead: false } });
  res.json({ unreadCount, alerts });
});

// PATCH /api/alerts/read-all
router.patch("/read-all", async (req, res) => {
  const { count } = await prisma.alert.updateMany({
    where: { userId: req.user!.userId, isRead: false },
    data: { isRead: true },
  });
  res.json({ updated: count });
});

// PATCH /api/alerts/:id/read – only your own alerts
router.patch("/:id/read", async (req, res) => {
  const alert = await prisma.alert.findUnique({ where: { id: req.params.id } });
  if (!alert) {
    return res.status(404).json({ error: "Alert not found" });
  }
  if (alert.userId !== req.user!.userId) {
    return res.status(403).json({ error: "Not your alert" });
  }
  const updated = await prisma.alert.update({ where: { id: alert.id }, data: { isRead: true } });
  res.json({ alert: updated });
});

// GET /api/alerts/history?type=&userId=
// ADMIN: every alert (filter by user/type). Others: their own only.
router.get("/history", async (req, res) => {
  const user = req.user!;
  const { type, userId } = historyQuerySchema.parse(req.query);

  const alerts = await prisma.alert.findMany({
    where: { type, userId: user.role === "ADMIN" ? userId : user.userId },
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
      deficiency: deficiencySummary,
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  res.json({ alerts });
});

export default router;
