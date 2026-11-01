import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@prisma/client";
import type { AuthUser } from "../types/express";

export const JWT_EXPIRES_IN = "8h";

export function signToken(user: AuthUser): string {
  return jwt.sign(user, process.env.JWT_SECRET!, { expiresIn: JWT_EXPIRES_IN });
}

// 401 unless the request has a valid "Authorization: Bearer <token>" header.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as AuthUser;
    req.user = {
      userId: payload.userId,
      role: payload.role,
      institutionId: payload.institutionId,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Use after requireAuth. 403 if the user's role is not in the allowed list.
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden for role " + req.user.role });
    }
    next();
  };
}
