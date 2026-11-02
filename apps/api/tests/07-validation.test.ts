import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, check, createApplication, createInstitution, createInstitutionUser, daysFromNow, file, form,
  institutionBody, PASSWORD, prisma, seeded, shared, uniqueCode, type Session,
} from "./helpers";

const MISSING = "doesnotexist0000000000000";

describe("7. Validation and error handling", () => {
  let admin: Session, officer1: Session, registrar: Session;
  let institutionId: string, appId: string, defId: string;

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
    const inst = await createInstitution(admin, "VAL", { labCount: 5 });
    institutionId = inst.id;
    registrar = await createInstitutionUser("validation-registrar@niyamsetu.test", inst.id, officer1.user.id);
    appId = await createApplication(admin, inst.id, officer1.user.id);
    defId = (await check(admin.token, appId)).deficienciesCreated[0].id;
  });

  // Each bad request must give 400 + { error: "Validation failed", issues: [{ path, message }] }.
  const badRequests: { label: string; who: () => Session | null; method: string; path: () => string; body?: unknown }[] = [
    { label: "login with no body", who: () => null, method: "POST", path: () => "/auth/login", body: {} },
    { label: "login with a malformed email", who: () => null, method: "POST", path: () => "/auth/login", body: { email: "not-an-email", password: "x" } },
    { label: "institution with an empty code", who: () => admin, method: "POST", path: () => "/institutions", body: institutionBody("") },
    { label: "institution with a negative intake", who: () => admin, method: "POST", path: () => "/institutions", body: institutionBody(uniqueCode("V"), { studentIntake: -5 }) },
    { label: "institution with a text intake", who: () => admin, method: "POST", path: () => "/institutions", body: institutionBody(uniqueCode("V"), { studentIntake: "many" }) },
    { label: "institution document with a bad expiry date", who: () => admin, method: "POST", path: () => "/institutions", body: institutionBody(uniqueCode("V"), { documents: [{ docType: "FIRE_NOC", fileName: "x.pdf", expiryDate: "soon" }] }) },
    { label: "application with no programme", who: () => admin, method: "POST", path: () => "/applications", body: { academicYear: "2027-28", institutionId: "x" } },
    { label: "stage with an unknown stage", who: () => officer1, method: "PATCH", path: () => `/applications/${appId}/stage`, body: { toStage: "DONE" } },
    { label: "assign with no officerId", who: () => admin, method: "POST", path: () => `/applications/${appId}/assign`, body: {} },
    { label: "expert visit with a bad date", who: () => officer1, method: "PATCH", path: () => `/applications/${appId}/expert-visit`, body: { expertVisitDate: "not-a-date", expertNames: "x" } },
    { label: "expert visit with no names", who: () => officer1, method: "PATCH", path: () => `/applications/${appId}/expert-visit`, body: { expertVisitDate: daysFromNow(2) } },
    { label: "check with a bad asOf", who: () => admin, method: "POST", path: () => `/applications/${appId}/check`, body: { asOf: "not-a-date" } },
    { label: "link-institution with a bad email", who: () => admin, method: "POST", path: () => "/users/link-institution", body: { email: "bad", institutionId: "x" } },
    { label: "deficiency assign with an empty body", who: () => officer1, method: "PATCH", path: () => `/deficiencies/${defId}/assign`, body: {} },
    { label: "deficiency assign with a bad date", who: () => officer1, method: "PATCH", path: () => `/deficiencies/${defId}/assign`, body: { dueDate: "tomorrow-ish" } },
    { label: "verify with an unknown decision", who: () => officer1, method: "PATCH", path: () => `/deficiencies/${defId}/verify`, body: { decision: "MAYBE" } },
    { label: "deficiency list with an unknown status", who: () => admin, method: "GET", path: () => "/deficiencies?status=NOPE" },
    { label: "alerts with unread=maybe", who: () => admin, method: "GET", path: () => "/alerts?unread=maybe" },
    { label: "alert history with an unknown type", who: () => admin, method: "GET", path: () => "/alerts/history?type=NOPE" },
    { label: "audit with limit=500 (max 200)", who: () => admin, method: "GET", path: () => "/audit?limit=500" },
    { label: "audit with limit=0", who: () => admin, method: "GET", path: () => "/audit?limit=0" },
    { label: "audit with limit=abc", who: () => admin, method: "GET", path: () => "/audit?limit=abc" },
    { label: "application audit with limit=201", who: () => admin, method: "GET", path: () => `/applications/${appId}/audit?limit=201` },
    { label: "dashboard overdue with limit=201", who: () => admin, method: "GET", path: () => "/dashboard/overdue?limit=201" },
  ];

  for (const b of badRequests) {
    it(`400 { error, issues }: ${b.label}`, async () => {
      const r = await api(b.who()?.token ?? null, b.method, b.path(), b.body);
      assert.equal(r.status, 400, r.raw);
      assert.equal(r.body.error, "Validation failed");
      assert.ok(Array.isArray(r.body.issues) && r.body.issues.length > 0);
      for (const i of r.body.issues) assert.equal(typeof i.message, "string");
    });
  }

  it("malformed JSON → 400 (not a server error)", async () => {
    const r = await api(admin.token, "POST", "/institutions", '{"code": "broken",');
    assert.equal(r.status, 400, r.raw);
    assert.equal(typeof r.body.error, "string");
  });

  // Unknown ids must give 404, never 500.
  const notFound: { label: string; who: () => Session; method: string; path: string; body?: () => unknown }[] = [
    { label: "GET application", who: () => admin, method: "GET", path: `/applications/${MISSING}` },
    { label: "PATCH application stage", who: () => admin, method: "PATCH", path: `/applications/${MISSING}/stage`, body: () => ({ toStage: "SCRUTINY" }) },
    { label: "POST application assign", who: () => admin, method: "POST", path: `/applications/${MISSING}/assign`, body: () => ({ officerId: officer1.user.id }) },
    { label: "PATCH expert visit", who: () => admin, method: "PATCH", path: `/applications/${MISSING}/expert-visit`, body: () => ({ expertVisitDate: daysFromNow(2), expertNames: "x" }) },
    { label: "POST check", who: () => admin, method: "POST", path: `/applications/${MISSING}/check` },
    { label: "GET checks", who: () => admin, method: "GET", path: `/applications/${MISSING}/checks` },
    { label: "GET application audit", who: () => admin, method: "GET", path: `/applications/${MISSING}/audit` },
    { label: "GET deficiency", who: () => admin, method: "GET", path: `/deficiencies/${MISSING}` },
    { label: "PATCH deficiency assign", who: () => admin, method: "PATCH", path: `/deficiencies/${MISSING}/assign`, body: () => ({ dueDate: daysFromNow(2) }) },
    { label: "POST evidence", who: () => registrar, method: "POST", path: `/deficiencies/${MISSING}/evidence`, body: () => form(file("e.pdf", "application/pdf")) },
    { label: "PATCH verify", who: () => admin, method: "PATCH", path: `/deficiencies/${MISSING}/verify`, body: () => ({ decision: "VERIFIED" }) },
    { label: "GET evidence file", who: () => admin, method: "GET", path: `/evidence/${MISSING}/file` },
    { label: "PATCH alert read", who: () => admin, method: "PATCH", path: `/alerts/${MISSING}/read` },
    { label: "link-institution: unknown email", who: () => admin, method: "POST", path: "/users/link-institution", body: () => ({ email: "nobody@niyamsetu.test", institutionId }) },
    { label: "link-institution: unknown institution", who: () => admin, method: "POST", path: "/users/link-institution", body: () => ({ email: "validation-registrar@niyamsetu.test", institutionId: MISSING }) },
    { label: "POST application for an unknown institution", who: () => admin, method: "POST", path: "/applications", body: () => ({ programme: "x", academicYear: "2027-28", institutionId: MISSING }) },
  ];

  for (const n of notFound) {
    it(`404: ${n.label}`, async () => {
      const r = await api(n.who().token, n.method, n.path, n.body?.());
      assert.equal(r.status, 404, r.raw);
      assert.equal(typeof r.body.error, "string");
    });
  }

  // Every list endpoint: ?limit default 50, min 1, max 200, and a `total` count.
  const lists: { path: () => string; key: string }[] = [
    { path: () => "/institutions", key: "institutions" },
    { path: () => "/applications", key: "applications" },
    { path: () => "/deficiencies", key: "deficiencies" },
    { path: () => "/alerts", key: "alerts" },
    { path: () => "/alerts/history", key: "alerts" },
    { path: () => "/audit", key: "audit" },
    { path: () => `/applications/${appId}/audit`, key: "audit" },
    { path: () => "/dashboard/overdue", key: "overdue" },
  ];

  for (const l of lists) {
    it(`?limit on GET ${l.path().replace(/cm\w+/, ":id")}: default 50, limit=2, 0 and 201 → 400`, async () => {
      const sep = l.path().includes("?") ? "&" : "?";
      const all = await api(admin.token, "GET", l.path());
      assert.equal(all.status, 200, all.raw);
      assert.equal(typeof all.body.total, "number");
      assert.equal(all.body[l.key].length, Math.min(all.body.total, 50));
      const two = await api(admin.token, "GET", `${l.path()}${sep}limit=2`);
      assert.equal(two.body[l.key].length, Math.min(two.body.total, 2));
      assert.equal(two.body.total, all.body.total);
      for (const bad of ["0", "201"]) {
        const r = await api(admin.token, "GET", `${l.path()}${sep}limit=${bad}`);
        assert.equal(r.status, 400, `limit=${bad}`);
        assert.equal(r.body.error, "Validation failed");
        assert.equal(r.body.issues[0].path, "limit");
      }
    });
  }

  it("GET /institutions: total equals the real row count and the default page is 50", async () => {
    // Make sure there are more than 50 institutions, so the default limit really cuts the list.
    while ((await prisma.institution.count()) <= 55) await createInstitution(admin, "PAGE");
    const r = await api(admin.token, "GET", "/institutions");
    assert.equal(r.body.total, await prisma.institution.count());
    assert.equal(r.body.institutions.length, 50);
    const max = await api(admin.token, "GET", "/institutions?limit=200");
    assert.equal(max.body.institutions.length, Math.min(r.body.total, 200));
  });

  it("unknown routes return the JSON error shape (404 { error })", async () => {
    const a = await api(null, "GET", "/does-not-exist");
    assert.equal(a.status, 404);
    assert.deepEqual(a.body, { error: "Not found" });
    const b = await api(admin.token, "GET", `/applications/${appId}/nope`);
    assert.equal(b.status, 404);
    assert.deepEqual(b.body, { error: "Not found" });
  });

  it("no response anywhere contains passwordHash (all responses of the whole run)", async () => {
    // Hit the endpoints that return user objects, then check everything recorded so far.
    await api(null, "POST", "/auth/login", { email: "admin1@niyamsetu.test", password: PASSWORD });
    for (const p of ["/auth/me", "/institutions", "/applications", `/applications/${appId}`, "/deficiencies",
      `/deficiencies/${defId}`, "/alerts/history?limit=200", "/audit?limit=200", "/dashboard/workload", "/dashboard/overdue"]) {
      const r = await api(admin.token, "GET", p);
      assert.equal(r.status, 200, p);
    }
    await api(admin.token, "POST", "/users/link-institution", { email: "validation-registrar@niyamsetu.test", institutionId });
    assert.deepEqual(shared.passwordHashLeaks, []);
  });
});
