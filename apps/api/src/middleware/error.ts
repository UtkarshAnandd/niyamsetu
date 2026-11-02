import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { MulterError } from "multer";
import { UploadError } from "./upload";
import { DB_CONNECTION_CODES } from "../db";

type BodyParserError = { type: string; status: number; message: string };
function isBodyParserError(err: unknown): err is BodyParserError {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Partial<BodyParserError>;
  return typeof e.type === "string" && typeof e.status === "number" && e.status >= 400 && e.status < 500;
}

// Last middleware in the chain. Express 5 sends errors from async routes here.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  // express.json() errors: malformed JSON (400) or a body that is too large (413).
  if (isBodyParserError(err)) {
    const message = err.type === "entity.parse.failed" ? "Malformed JSON body" : err.message;
    return res.status(err.status).json({ error: message });
  }
  if (err instanceof MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "File too large (max 5 MB)" : err.message;
    return res.status(400).json({ error: message });
  }
  if (err instanceof UploadError) {
    return res.status(400).json({ error: err.message });
  }
  // Database down or restarting: tell the client to try again rather than "server error".
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && DB_CONNECTION_CODES.includes(err.code))
  ) {
    console.error("[db] unavailable:", (err as Error).message.split("\n").pop());
    return res.status(503).json({ error: "Database unavailable, try again" });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "Already exists", fields: err.meta?.target });
    }
    if (err.code === "P2025") {
      return res.status(404).json({ error: "Record not found" });
    }
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
