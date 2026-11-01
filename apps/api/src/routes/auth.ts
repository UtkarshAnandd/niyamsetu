import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../services/audit";
import { requireAuth, signToken } from "../middleware/auth";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Fields that are safe to send to the browser (never passwordHash).
const publicUserFields = {
  id: true,
  email: true,
  name: true,
  role: true,
  institutionId: true,
  managerId: true,
} as const;

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken({ userId: user.id, role: user.role, institutionId: user.institutionId });
  await audit(user.id, "LOGIN", "User", user.id, null, { email: user.email, role: user.role });

  const { passwordHash, ...safeUser } = user;
  res.json({ token, user: safeUser });
});

// GET /api/auth/me
router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: publicUserFields,
  });
  if (!user) {
    return res.status(401).json({ error: "User no longer exists" });
  }
  res.json({ user });
});

export default router;
