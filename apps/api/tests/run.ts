// `npm test`: resets the niyamsetu_test database, starts the API on port 4100 with
// cron disabled, runs tests/*.test.ts, stops the API and writes docs/TEST_REPORT.md.
// It never touches the niyamsetu (dev/demo) database.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { run } from "node:test";

const API_DIR = path.resolve(__dirname, "..");
const REPORT_PATH = path.resolve(API_DIR, "../../docs/TEST_REPORT.md");
const PORT = "4100";

// ---------- 1. Point everything at niyamsetu_test ----------
const devUrl = process.env.DATABASE_URL ?? "";
const testUrl = devUrl.replace(/\/niyamsetu(\?|$)/, "/niyamsetu_test$1");
// Guard: the database name must be exactly niyamsetu_test – never niyamsetu.
if (!URL.canParse(testUrl) || new URL(testUrl).pathname !== "/niyamsetu_test") {
  console.error("Could not derive the niyamsetu_test URL from DATABASE_URL. Aborting.");
  process.exit(1);
}
process.env.DATABASE_URL = testUrl;
process.env.DEMO_MODE = "true";
process.env.TEST_PORT = PORT;

// trimEnd only: `git status --porcelain` lines start with a significant space.
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: API_DIR }).toString().trimEnd();

async function main() {
  const startedAt = new Date();
  const commit = git("rev-parse HEAD");
  const changed = git("status --porcelain").split("\n").filter(Boolean).map((l) => l.slice(3));
  const appCodeChanged = changed.filter((p) => /^apps\/api\/(src|prisma)\//.test(p));

  console.log("Resetting niyamsetu_test (migrate reset + seed)...");
  execSync("npx prisma migrate reset --force", { cwd: API_DIR, stdio: "inherit", env: process.env });

  console.log(`Starting API on port ${PORT} (DISABLE_CRON=true, DEMO_MODE=true)...`);
  const serverLog: string[] = [];
  const server = spawn("node", ["--env-file=.env", "--import", "tsx", "src/index.ts"], {
    cwd: API_DIR,
    env: { ...process.env, PORT, DISABLE_CRON: "true" },
  });
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));
  await waitForHealth();

  // ---------- 2. Run the test files in this process, one at a time ----------
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => path.join(__dirname, f));

  type Result = { name: string; ok: boolean; error?: string };
  const areas: { area: string; results: Result[] }[] = [];
  let pending: Result[] = [];

  for await (const event of run({ files, isolation: "none", concurrency: 1 }) as AsyncIterable<any>) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { name, nesting, details } = event.data;
    if (details?.type === "suite") {
      // A top-level suite finishes after its tests: everything pending belongs to it.
      if (nesting === 0) {
        areas.push({ area: name, results: pending });
        pending = [];
        // Each file has one top-level suite. With isolation "none" the stream only ends once
        // every open connection closes, so stop reading when all files have reported.
        if (areas.length === files.length) break;
      }
      continue;
    }
    const ok = event.type === "test:pass";
    const err = details?.error;
    const result: Result = { name, ok, error: ok ? undefined : String(err?.cause?.message ?? err?.message ?? err) };
    console.log(`${ok ? "  ✔" : "  ✖"} ${name}${ok ? "" : `\n      ${result.error}`}`);
    if (nesting === 0) {
      areas.push({ area: name, results: [result] }); // e.g. a file that failed to load
      if (areas.length === files.length) break;
    } else {
      pending.push(result);
    }
  }

  // ---------- 3. Traceability metric, measured on the test database ----------
  // DATABASE_URL already points at niyamsetu_test (set at the top of this file).
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const deficiencies = await prisma.deficiency.findMany({
    include: { ruleCheck: { include: { rule: true } }, evidence: true },
  });
  const createAudits = new Set(
    (await prisma.auditLog.findMany({ where: { entityType: "Deficiency", action: "CREATE" }, select: { entityId: true } }))
      .map((a) => a.entityId)
  );
  const trace = { total: deficiencies.length, complete: 0, missing: { ruleVersion: 0, createAudit: 0, verification: 0 } };
  for (const d of deficiencies) {
    const hasRule = !!d.ruleCheck?.rule;
    const hasAudit = createAudits.has(d.id);
    const verifiedOk = d.status !== "VERIFIED" || d.evidence.some((e) => e.verifiedById && e.verifiedAt);
    if (!hasRule) trace.missing.ruleVersion++;
    if (!hasAudit) trace.missing.createAudit++;
    if (!verifiedOk) trace.missing.verification++;
    if (hasRule && hasAudit && verifiedOk) trace.complete++;
  }
  const verifiedCount = deficiencies.filter((d) => d.status === "VERIFIED").length;

  // ---------- 4. Clean up: only upload files recorded in the test database ----------
  const evidence = await prisma.evidence.findMany({ select: { filePath: true } });
  let removed = 0;
  for (const e of evidence) {
    const p = path.join(API_DIR, "uploads", path.basename(e.filePath));
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed++;
    }
  }
  await prisma.$disconnect();
  server.kill();

  // ---------- 5. Summary + report ----------
  const total = areas.reduce((n, a) => n + a.results.length, 0);
  const passed = areas.reduce((n, a) => n + a.results.filter((r) => r.ok).length, 0);
  const failed = total - passed;
  const finishedAt = new Date();
  const metrics = (globalThis as any).__niyamsetuTest?.metrics ?? {};

  console.log("\nArea                                   Passed  Failed");
  for (const a of areas) {
    const p = a.results.filter((r) => r.ok).length;
    console.log(`${a.area.padEnd(38)} ${String(p).padStart(6)}  ${String(a.results.length - p).padStart(6)}`);
  }
  console.log(`${"TOTAL".padEnd(38)} ${String(passed).padStart(6)}  ${String(failed).padStart(6)}`);
  console.log(`Removed ${removed} test upload file(s) from apps/api/uploads/.`);
  if (failed > 0) {
    console.log("\nServer log:\n" + serverLog.join(""));
  }

  const report = buildReport({
    startedAt, finishedAt, commit, changed, appCodeChanged, areas, total, passed, failed,
    metrics, trace, verifiedCount,
  });
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`Report written to ${path.relative(path.resolve(API_DIR, "../.."), REPORT_PATH)}`);

  process.exit(failed > 0 ? 1 : 0);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API did not start on port " + PORT);
}

function pct(n: number, d: number) {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`;
}

function buildReport(r: any) {
  const det = r.metrics.deadlineDetection;
  const alerts = r.metrics.alertCorrectness;
  const lines: string[] = [];
  lines.push("# NiyamSetu – End-to-end Test Report", "");
  lines.push(
    "> **All results below were measured on synthetic, fictional data in DEMO_MODE**",
    "> (deadlines in minutes instead of days). Institutions, people and rule thresholds",
    "> are placeholders; no real AICTE data was used. Numbers are exactly what this run",
    "> measured – nothing is rounded up or estimated.",
    ""
  );
  lines.push("| Item | Value |", "| --- | --- |");
  lines.push(`| Run started | ${r.startedAt.toISOString()} |`);
  lines.push(`| Run finished | ${r.finishedAt.toISOString()} |`);
  lines.push(`| Commit tested | \`${r.commit}\` |`);
  lines.push(
    `| Application code (apps/api/src, apps/api/prisma) | ${
      r.appCodeChanged.length === 0
        ? "identical to the commit above"
        : "commit above **plus uncommitted changes to:** " + r.appCodeChanged.join(", ")
    } |`
  );
  if (r.changed.length > 0) {
    lines.push(`| Other uncommitted files at run time | ${r.changed.filter((p: string) => !r.appCodeChanged.includes(p)).join(", ") || "none"} |`);
  }
  lines.push(`| Database | niyamsetu_test (reset and seeded at start) |`);
  lines.push(`| Mode | DEMO_MODE=true, DISABLE_CRON=true, API on port 4100 |`);
  lines.push(`| Node.js | ${process.version} |`);
  lines.push(`| Reproduce | \`cd apps/api && npm test\` |`, "");

  lines.push("## Summary", "");
  lines.push(`- Total tests: **${r.total}**`);
  lines.push(`- Passed: **${r.passed}**`);
  lines.push(`- Failed: **${r.failed}**`, "");

  lines.push("## Results per area", "");
  lines.push("| Area | Tests | Passed | Failed |", "| --- | ---: | ---: | ---: |");
  for (const a of r.areas) {
    const p = a.results.filter((x: any) => x.ok).length;
    lines.push(`| ${a.area} | ${a.results.length} | ${p} | ${a.results.length - p} |`);
  }
  lines.push("");
  const failures = r.areas.flatMap((a: any) => a.results.filter((x: any) => !x.ok).map((x: any) => ({ area: a.area, ...x })));
  if (failures.length > 0) {
    lines.push("### Failures", "");
    for (const f of failures) lines.push(`- **${f.area} › ${f.name}**: ${String(f.error).split("\n")[0]}`);
    lines.push("");
  }

  lines.push("## Brief metrics", "");
  lines.push("### 1. Deadline detection", "");
  if (det) {
    lines.push(
      `${det.correct} of ${det.total} deficiencies were classified correctly by a single deadline-engine run ` +
        `(${pct(det.correct, det.total)}). Due dates were placed around an injected time T: ` +
        `${det.counts.overdue} past due, ${det.counts.dueSoon} inside the ${det.dueSoonWindow} due-soon window, ` +
        `${det.counts.notYet} outside it; ${det.counts.escalate} were past the ${det.grace} grace period.`,
      "",
      `Detection latency: one engine run. The cron schedule runs the engine every minute; the deficiencies were ` +
        `detected in the first run at T, with no further runs needed.`,
      ""
    );
  } else {
    lines.push("Not measured (the deadline tests did not record a result).", "");
  }
  lines.push("### 2. Alert correctness", "");
  if (alerts) {
    lines.push(
      `${alerts.correct} of ${alerts.expected} expected alerts were delivered to the right recipient with the right ` +
        `type (${pct(alerts.correct, alerts.expected)}). Unexpected alerts: ${alerts.unexpected}. ` +
        `Duplicate alerts after ${alerts.extraRuns} further engine runs: ${alerts.duplicates}.`,
      "",
      "Recipients covered: deficiency owner, owner's manager (escalation), assigned officer (no owner), " +
        "assigned officer's manager (escalation without owner), all ADMIN users (no owner and no officer).",
      ""
    );
  } else {
    lines.push("Not measured (the deadline tests did not record a result).", "");
  }
  lines.push("### 3. Deficiency traceability", "");
  lines.push(
    `${r.trace.complete} of ${r.trace.total} deficiencies in the test database have a complete chain ` +
      `(${pct(r.trace.complete, r.trace.total)}): rule check → exact rule version → CREATE audit row, and for the ` +
      `${r.verifiedCount} VERIFIED deficiencies also evidence → verifying officer → verification time.`,
    "",
    `Missing links: rule version ${r.trace.missing.ruleVersion}, CREATE audit row ${r.trace.missing.createAudit}, ` +
      `verification record ${r.trace.missing.verification}.`,
    ""
  );
  lines.push("## Notes", "");
  lines.push(
    "- Extra fictional INSTITUTION logins used by the tests are inserted directly into the test database (there is no user-creation route).",
    "- Deadline tests call the engine function `runDeadlineCheck(now)` with an injected time against the same test database; the HTTP fallback route is covered in the RBAC tests.",
    "- Upload files created by the tests are deleted after the run; only files recorded in the test database's Evidence rows are removed.",
    ""
  );
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
