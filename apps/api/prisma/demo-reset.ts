// npm run demo:reset – re-seeds the niyamsetu dev database and empties uploads/ (keeps .gitkeep),
// so seed data and evidence files never get out of step.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const API_DIR = path.resolve(__dirname, "..");
const UPLOADS = path.join(API_DIR, "uploads");

// Guard: only the dev/demo database (the tests use niyamsetu_test and reset it themselves).
const url = process.env.DATABASE_URL ?? "";
if (!URL.canParse(url) || new URL(url).pathname !== "/niyamsetu") {
  console.error("demo:reset only runs against the niyamsetu database. Aborting.");
  process.exit(1);
}

// The seed deletes every row and inserts the fictional demo data. If it fails, files are kept.
execSync("npx prisma db seed", { cwd: API_DIR, stdio: "inherit" });

let removed = 0;
for (const name of fs.readdirSync(UPLOADS)) {
  if (name === ".gitkeep") continue;
  fs.rmSync(path.join(UPLOADS, name), { recursive: true, force: true });
  removed++;
}
console.log(`demo:reset done – database re-seeded, ${removed} file(s) removed from uploads/.`);
