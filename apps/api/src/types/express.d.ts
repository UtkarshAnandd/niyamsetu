import type { Role } from "@prisma/client";

// What we store in the JWT and attach to req.user after requireAuth.
export interface AuthUser {
  userId: string;
  role: Role;
  institutionId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
