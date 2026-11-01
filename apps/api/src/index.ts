import express from "express";
import cors from "cors";
import { prisma } from "./db";
import authRoutes from "./routes/auth";
import institutionRoutes from "./routes/institutions";
import applicationRoutes from "./routes/applications";
import userRoutes from "./routes/users";
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
app.use("/api/users", userRoutes);

app.use(errorHandler);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`NiyamSetu API listening on http://localhost:${port}`);
});
