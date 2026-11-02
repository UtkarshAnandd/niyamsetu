import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, check, createApplication, createInstitution, createInstitutionUser, daysFromNow, file, form,
  prisma, seeded, type Session,
} from "./helpers";

const docs = (fireNoc: "valid" | "missing" | "expired") => [
  { docType: "LAND_DEED", fileName: "land-deed.pdf" },
  { docType: "BUILDING_PLAN", fileName: "building-plan.pdf" },
  ...(fireNoc === "missing" ? [] : [{
    docType: "FIRE_NOC",
    fileName: "fire-noc.pdf",
    expiryDate: daysFromNow(fireNoc === "valid" ? 365 : -1),
  }]),
];

// Base institution passes everything: ratio 16.7, 12 sqm/student, 3 acres, 7 labs, documents valid.
// Each case changes one field. "pass" values sit exactly on the threshold.
const CASES: { code: string; label: string; pass: Record<string, unknown>; fail: Record<string, unknown>; failText: RegExp }[] = [
  { code: "FACULTY_RATIO", label: "FACULTY_RATIO", pass: { facultyCount: 10 }, fail: { facultyCount: 8 }, failText: /25:1 exceeds max 20:1/ },
  { code: "MIN_BUILTUP_AREA", label: "MIN_BUILTUP_AREA", pass: { builtUpAreaSqm: 2000 }, fail: { builtUpAreaSqm: 1999 }, failText: /below min 10/ },
  { code: "MIN_LAND_AREA", label: "MIN_LAND_AREA", pass: { landAreaAcres: 2.5 }, fail: { landAreaAcres: 2.4 }, failText: /2\.4 acres is below min 2\.5/ },
  { code: "MIN_LABS", label: "MIN_LABS", pass: { labCount: 6 }, fail: { labCount: 5 }, failText: /5 labs is below min 6/ },
  { code: "REQUIRED_DOCUMENTS", label: "REQUIRED_DOCUMENTS (missing FIRE_NOC)", pass: { documents: docs("valid") }, fail: { documents: docs("missing") }, failText: /FIRE_NOC missing/ },
  { code: "REQUIRED_DOCUMENTS", label: "REQUIRED_DOCUMENTS (expired FIRE_NOC)", pass: { documents: docs("valid") }, fail: { documents: docs("expired") }, failText: /FIRE_NOC expired/ },
];

describe("3. Rules engine", () => {
  let admin: Session, officer1: Session;

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
  });

  const checkInstitution = async (overrides: Record<string, unknown>) => {
    const inst = await createInstitution(admin, "RULE", overrides);
    const appId = await createApplication(admin, inst.id, officer1.user.id);
    return { appId, result: await check(admin.token, appId) };
  };

  for (const c of CASES) {
    it(`${c.label} passes at the threshold`, async () => {
      const { result } = await checkInstitution(c.pass);
      const r = result.results.find((x: any) => x.code === c.code);
      assert.equal(r.passed, true, `${r.actual} vs ${r.expected}`);
      assert.equal(result.results.filter((x: any) => !x.passed).length, 0);
      assert.equal(result.deficienciesCreated.length, 0);
    });

    it(`${c.label} fails just past the threshold and creates one traceable deficiency`, async () => {
      const { appId, result } = await checkInstitution(c.fail);
      const failed = result.results.filter((x: any) => !x.passed).map((x: any) => x.code);
      assert.deepEqual(failed, [c.code]);
      assert.equal(result.deficienciesCreated.length, 1);
      const d = await prisma.deficiency.findFirstOrThrow({
        where: { applicationId: appId },
        include: { ruleCheck: { include: { rule: true } } },
      });
      const rule = d.ruleCheck!.rule;
      assert.equal(rule.code, c.code);
      assert.match(d.requirement, c.failText);
      assert.ok(d.requirement.endsWith(`(${rule.code} v${rule.version})`), d.requirement);
      assert.equal(d.evidenceNeeded, (rule.params as any).evidenceNeeded);
      assert.equal(d.ruleCheck!.passed, false);
    });
  }

  it("a failing value shows enough decimals to be visibly below a minimum (9.99, not 10.0)", async () => {
    const { appId, result } = await checkInstitution({ builtUpAreaSqm: 1999 }); // 1999 / 200 = 9.995
    const r = result.results.find((x: any) => x.code === "MIN_BUILTUP_AREA");
    assert.equal(r.passed, false);
    assert.equal(r.actual, "9.99 sqm/student");
    const d = await prisma.deficiency.findFirstOrThrow({ where: { applicationId: appId } });
    assert.match(d.requirement, /^Built-up area 9\.99 sqm per student is below min 10 /);
  });

  it("a failing value shows enough decimals to be visibly above a maximum (20.01, not 20.0)", async () => {
    // 2001 / 100 = 20.01; built-up area raised so only the ratio fails
    const { result } = await checkInstitution({ studentIntake: 2001, facultyCount: 100, builtUpAreaSqm: 24012 });
    const failed = result.results.filter((x: any) => !x.passed);
    assert.deepEqual(failed.map((x: any) => x.code), ["FACULTY_RATIO"]);
    assert.equal(failed[0].actual, "20.01:1");
    assert.match(result.deficienciesCreated[0].requirement, /^Faculty ratio 20\.01:1 exceeds max 20:1 /);
  });

  it("passing values keep one decimal (16.7:1)", async () => {
    const { result } = await checkInstitution({}); // 200 / 12 = 16.67
    assert.equal(result.results.find((x: any) => x.code === "FACULTY_RATIO").actual, "16.7:1");
  });

  it("a document with no expiry date never counts as expired", async () => {
    const { result } = await checkInstitution({
      documents: [
        { docType: "LAND_DEED", fileName: "a.pdf" },
        { docType: "BUILDING_PLAN", fileName: "b.pdf" },
        { docType: "FIRE_NOC", fileName: "c.pdf" },
      ],
    });
    assert.equal(result.results.find((x: any) => x.code === "REQUIRED_DOCUMENTS").passed, true);
  });

  describe("versioning: FACULTY_RATIO v1 (max 15, to 2026-06-30) vs v2 (max 20, from 2026-07-01)", () => {
    let appId: string;

    before(async () => {
      const inst = await createInstitution(admin, "VER", { studentIntake: 180, facultyCount: 10 }); // 18:1
      appId = await createApplication(admin, inst.id, officer1.user.id);
    });

    it("a normal check uses the version in force on submittedAt (v2) and passes", async () => {
      const r = await check(admin.token, appId);
      const fr = r.results.find((x: any) => x.code === "FACULTY_RATIO");
      assert.deepEqual([fr.version, fr.passed, fr.actual, fr.expected], [2, true, "18:1", "max 20:1"]);
      assert.equal(r.preview, false);
    });

    it("ADMIN asOf 2026-06-01 uses v1 and fails, as a preview with no deficiencies", async () => {
      const r = await check(admin.token, appId, { asOf: "2026-06-01" });
      const fr = r.results.find((x: any) => x.code === "FACULTY_RATIO");
      assert.deepEqual([fr.version, fr.passed, fr.expected], [1, false, "max 15:1"]);
      assert.equal(r.preview, true);
      assert.equal(r.deficienciesSkipped, "asOf preview");
      assert.equal(r.deficienciesCreated.length, 0);
      assert.equal(await prisma.deficiency.count({ where: { applicationId: appId } }), 0);
      assert.equal(await prisma.ruleCheck.count({ where: { applicationId: appId, isPreview: true } }), 5);
    });

    it("v1 still applies on its last day (2026-06-30) and v2 from 2026-07-01", async () => {
      const last = await check(admin.token, appId, { asOf: "2026-06-30T18:00:00Z" });
      const first = await check(admin.token, appId, { asOf: "2026-07-01T00:00:00Z" });
      assert.equal(last.results.find((x: any) => x.code === "FACULTY_RATIO").version, 1);
      assert.equal(first.results.find((x: any) => x.code === "FACULTY_RATIO").version, 2);
    });

    it("before any rule was in force, every rule reports 'No version in force'", async () => {
      const r = await check(admin.token, appId, { asOf: "2024-01-01" });
      assert.ok(r.results.every((x: any) => x.version === null && x.passed === null));
      assert.equal(r.deficienciesCreated.length, 0);
    });

    it("GET /checks ignores preview runs and shows the real latest result (v2 pass)", async () => {
      const r = await api(admin.token, "GET", `/applications/${appId}/checks`);
      const fr = r.body.checks.find((x: any) => x.code === "FACULTY_RATIO");
      assert.deepEqual([fr.version, fr.passed], [2, true]);
    });

    it("only ADMIN may pass asOf (OFFICER → 403)", async () => {
      const r = await api(officer1.token, "POST", `/applications/${appId}/check`, { asOf: "2026-06-01" });
      assert.equal(r.status, 403);
    });

    it("rules are never overwritten: 6 rule rows, v1 and v2 thresholds unchanged", async () => {
      const rules = await prisma.complianceRule.findMany({ where: { code: "FACULTY_RATIO" }, orderBy: { version: "asc" } });
      assert.equal(await prisma.complianceRule.count(), 6);
      assert.deepEqual(rules.map((r) => (r.params as any).maxStudentsPerFaculty), [15, 20]);
      for (const r of await prisma.complianceRule.findMany()) assert.match(r.source, /placeholder/);
    });
  });

  describe("idempotency", () => {
    it("re-running a check 3 times never duplicates the open deficiency", async () => {
      const { appId } = await checkInstitution({ labCount: 5 });
      for (let i = 0; i < 3; i++) {
        const r = await check(admin.token, appId);
        assert.equal(r.deficienciesCreated.length, 0);
        assert.equal(r.deficienciesAlreadyOpen.length, 1);
        assert.equal(r.deficienciesAlreadyOpen[0].code, "MIN_LABS");
      }
      assert.equal(await prisma.deficiency.count({ where: { applicationId: appId } }), 1);
      assert.equal(await prisma.ruleCheck.count({ where: { applicationId: appId } }), 20); // 4 runs × 5 rules
    });

    it("once VERIFIED, a re-run creates a new deficiency if the rule still fails", async () => {
      const inst = await createInstitution(admin, "IDEM", { labCount: 5 });
      const registrar = await createInstitutionUser("idem-registrar@niyamsetu.test", inst.id, officer1.user.id);
      const appId = await createApplication(admin, inst.id, officer1.user.id);
      const first = (await check(admin.token, appId)).deficienciesCreated[0].id;
      await api(registrar.token, "POST", `/deficiencies/${first}/evidence`, form(file("labs.pdf", "application/pdf")));
      const v = await api(officer1.token, "PATCH", `/deficiencies/${first}/verify`, { decision: "VERIFIED" });
      assert.equal(v.status, 200);
      const again = await check(admin.token, appId);
      assert.equal(again.deficienciesCreated.length, 1);
      assert.notEqual(again.deficienciesCreated[0].id, first);
    });
  });
});
