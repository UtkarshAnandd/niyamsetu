// Shared helpers for the end-to-end tests. Run the suite with `npm test`,
// which points everything at the separate niyamsetu_test database.
import assert from "node:assert/strict";
import fs from "node:fs";
import bcrypt from "bcryptjs";
import { prisma } from "../src/db";
import { UPLOAD_DIR } from "../src/middleware/upload";

if (!process.env.DATABASE_URL?.includes("/niyamsetu_test")) {
  throw new Error("Tests must run against the niyamsetu_test database. Use `npm test`.");
}

export { prisma };
export const BASE = `http://localhost:${process.env.TEST_PORT ?? "4100"}/api`;
export const PASSWORD = "Demo@123";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// State shared between test files and tests/run.ts (they run in one process).
type Shared = { passwordHashLeaks: string[]; metrics: Record<string, unknown> };
declare global {
  // eslint-disable-next-line no-var
  var __niyamsetuTest: Shared | undefined;
}
export const shared: Shared = (globalThis.__niyamsetuTest ??= { passwordHashLeaks: [], metrics: {} });

export type Res = { status: number; body: any; raw: string; headers: Headers };

// Calls the API. body: object (sent as JSON), string (sent as raw JSON text) or FormData.
// Every response is scanned for "passwordHash".
export async function api(token: string | null, method: string, path: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (typeof body === "string") {
    headers["Content-Type"] = "application/json";
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const raw = await res.text();
  if (raw.includes("passwordHash")) shared.passwordHashLeaks.push(`${method} ${path}`);
  let parsed: any = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // not JSON (e.g. an evidence file)
  }
  return { status: res.status, body: parsed, raw, headers: res.headers };
}

// Raw bytes, for checking downloaded evidence files.
export async function apiBytes(token: string, path: string) {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get("content-type"), bytes: Buffer.from(await res.arrayBuffer()) };
}

export type Session = { token: string; user: { id: string; email: string; role: string; institutionId: string | null; managerId: string | null } };

export async function login(email: string): Promise<Session> {
  const r = await api(null, "POST", "/auth/login", { email, password: PASSWORD });
  assert.equal(r.status, 200, `login ${email} failed: ${r.raw}`);
  return { token: r.body.token, user: r.body.user };
}
export const seeded = (name: string) => login(`${name}@niyamsetu.test`);

let counter = 0;
export function uniqueCode(prefix: string) {
  counter++;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export const minutesFromNow = (n: number) => new Date(Date.now() + n * MINUTE).toISOString();
export const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString();

// A fictional institution that passes all 5 placeholder rules unless overridden:
// ratio 200/12 = 16.7, 12 sqm/student, 3 acres, 7 labs, all documents valid.
export function institutionBody(code: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    name: `Test Institute ${code} (fictional)`,
    state: "Teststate",
    city: "Testnagar",
    type: "Engineering",
    studentIntake: 200,
    facultyCount: 12,
    builtUpAreaSqm: 2400,
    landAreaAcres: 3,
    labCount: 7,
    documents: [
      { docType: "LAND_DEED", fileName: `${code}-land-deed.pdf` },
      { docType: "BUILDING_PLAN", fileName: `${code}-building-plan.pdf` },
      { docType: "FIRE_NOC", fileName: `${code}-fire-noc.pdf`, expiryDate: daysFromNow(365) },
    ],
    ...overrides,
  };
}

export async function createInstitution(admin: Session, prefix: string, overrides: Record<string, unknown> = {}) {
  const r = await api(admin.token, "POST", "/institutions", institutionBody(uniqueCode(prefix), overrides));
  assert.equal(r.status, 201, r.raw);
  return r.body.institution as { id: string; code: string };
}

// Test fixture: an extra fictional INSTITUTION login, inserted directly into the test database.
let passwordHash: string | undefined;
export async function createInstitutionUser(email: string, institutionId: string | null, managerId: string | null) {
  passwordHash ??= bcrypt.hashSync(PASSWORD, 10);
  await prisma.user.create({
    data: { email, name: `Test Registrar ${email.split("@")[0]} (fictional)`, role: "INSTITUTION", passwordHash, institutionId, managerId },
  });
  return login(email);
}

// ADMIN creates an application for an institution and (optionally) assigns an officer.
export async function createApplication(admin: Session, institutionId: string, officerId?: string) {
  const r = await api(admin.token, "POST", "/applications", {
    programme: "B.Tech Test Programme",
    academicYear: "2027-28",
    institutionId,
  });
  assert.equal(r.status, 201, r.raw);
  if (officerId) {
    const a = await api(admin.token, "POST", `/applications/${r.body.application.id}/assign`, { officerId });
    assert.equal(a.status, 200, a.raw);
  }
  return r.body.application.id as string;
}

export async function check(token: string, appId: string, body?: unknown) {
  const r = await api(token, "POST", `/applications/${appId}/check`, body);
  assert.equal(r.status, 200, r.raw);
  return r.body;
}

export function file(name: string, type: string, size = 64) {
  return new File([new Uint8Array(size).fill(37)], name, { type });
}
export function form(f?: File, note?: string) {
  const fd = new FormData();
  if (f) fd.append("file", f);
  if (note) fd.append("note", note);
  return fd;
}

export function uploadsOnDisk() {
  return fs.readdirSync(UPLOAD_DIR).filter((f) => f !== ".gitkeep").length;
}

export const auditCount = () => prisma.auditLog.count();

export async function latestAudit(entityType: string, entityId: string, action?: string) {
  return prisma.auditLog.findFirst({
    where: { entityType, entityId, ...(action && { action: action as any }) },
    orderBy: { createdAt: "desc" },
  });
}

export async function alertByKey(dedupKey: string) {
  return prisma.alert.findUnique({ where: { dedupKey } });
}
