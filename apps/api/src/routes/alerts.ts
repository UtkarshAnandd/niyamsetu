import { Router } from "express";
import { z } from "zod";
import { AlertType } from "@prisma/client";
import { prisma } from "../db";
import { idParams, limitField } from "../services/validation";
import { requireAuth } from "../middleware/auth";

// Read receipts are not audited: they are not regulatory actions.
const router = Router();
router.use(requireAuth);

const listQuerySchema = z.object({ unread: z.enum(["true", "false"]).optional(), limit: limitField });
const historyQuerySchema = z.object({
  type: z.enum(AlertType).optional(),
  userId: z.string().optional(),
  limit: limitField,
});

const deficiencySummary = {
  select: { id: true, requirement: true, status: true, applicationId: true },
} as const;

// GET /api/alerts?unread=true&limit= – the current user's alerts, newest first
router.get("/", async (req, res) => {
  const { unread, limit } = listQuerySchema.parse(req.query);
  const where = { userId: req.user!.userId, ...(unread === "true" && { isRead: false }) };
  const [total, unreadCount, alerts] = await Promise.all([
    prisma.alert.count({ where }),
    prisma.alert.count({ where: { userId: req.user!.userId, isRead: false } }),
    prisma.alert.findMany({
      where,
      include: { deficiency: deficiencySummary },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);
  res.json({ total, unreadCount, alerts });
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
  const alert = await prisma.alert.findUnique({ where: { id: idParams.parse(req.params).id } });
  if (!alert) {
    return res.status(404).json({ error: "Alert not found" });
  }
  if (alert.userId !== req.user!.userId) {
    return res.status(403).json({ error: "Not your alert" });
  }
  const updated = await prisma.alert.update({ where: { id: alert.id }, data: { isRead: true } });
  res.json({ alert: updated });
});

// GET /api/alerts/history?type=&userId=&limit=
// ADMIN: every alert (filter by user/type). Others: their own only.
router.get("/history", async (req, res) => {
  const user = req.user!;
  const { type, userId, limit } = historyQuerySchema.parse(req.query);
  const where = { type, userId: user.role === "ADMIN" ? userId : user.userId };

  const [total, alerts] = await Promise.all([
    prisma.alert.count({ where }),
    prisma.alert.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
        deficiency: deficiencySummary,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);
  res.json({ total, alerts });
});

export default router;
