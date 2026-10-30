import express from "express";
import { prisma } from "./db";

const app = express();
app.use(express.json());

// Health check: confirms the API is up and the database answers.
app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", db: "up", demoMode: process.env.DEMO_MODE === "true" });
  } catch {
    res.status(500).json({ status: "error", db: "down" });
  }
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`NiyamSetu API listening on http://localhost:${port}`);
});
