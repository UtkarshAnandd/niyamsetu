import express from "express";
import cors from "cors";
import { prisma } from "./db";
import authRoutes from "./routes/auth";
import institutionRoutes from "./routes/institutions";
import applicationRoutes from "./routes/applications";
import userRoutes from "./routes/users";
import checkRoutes from "./routes/checks";
import deficiencyRoutes from "./routes/deficiencies";
import evidenceRoutes from "./routes/evidence";
import alertRoutes from "./routes/alerts";
import adminRoutes from "./routes/admin";
import dashboardRoutes from "./routes/dashboard";
import { auditRouter, applicationAuditRouter } from "./routes/audit";
import { startDeadlineCron } from "./jobs/deadlines";
import { errorHandler } from "./middleware/error";

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set. Copy .env.example to .env.");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: "http://localhost:5173" }));
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

app.use("/api/auth", authRoutes);
app.use("/api/institutions", institutionRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/applications", checkRoutes);
app.use("/api/deficiencies", deficiencyRoutes);
app.use("/api/evidence", evidenceRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/audit", auditRouter);
app.use("/api/applications", applicationAuditRouter);
app.use("/api/users", userRoutes);

app.use(errorHandler);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`NiyamSetu API listening on http://localhost:${port}`);
  if (process.env.DISABLE_CRON === "true") {
    console.log("[cron] disabled (DISABLE_CRON=true)");
  } else {
    startDeadlineCron();
  }
});
