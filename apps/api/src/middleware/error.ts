import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

// Last middleware in the chain. Express 5 sends errors from async routes here.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
