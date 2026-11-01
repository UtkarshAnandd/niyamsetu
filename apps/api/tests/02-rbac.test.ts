import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, check, createApplication, createInstitution, createInstitutionUser, daysFromNow, file, form,
  institutionBody, prisma, seeded, uniqueCode, type Session,
} from "./helpers";
import { createAlert } from "../src/services/alerts";

type Role = "ADMIN" | "OFFICER" | "INSTITUTION";
const ROLES: Role[] = ["ADMIN", "OFFICER", "INSTITUTION"];

describe("2. RBAC", () => {
  let admin: Session, officer1: Session, officer2: Session, inst1: Session;
  let instUser: Session, spareEmail: string, institutionId: string;
  const as: Record<Role, () => Session> = {
    ADMIN: () => admin,
    OFFICER: () => officer1, // the officer assigned to every fixture application
    INSTITUTION: () => instUser, // linked to the fixture college
  };

  // A fresh application for the fixture college, assigned to officer1.
  const freshApp = () => createApplication(admin, institutionId, officer1.user.id);
  // A fresh OPEN deficiency (the fixture college fails MIN_LABS), owned by instUser.
  const freshDeficiency = async () => {
    const appId = await freshApp();
    const result = await check(admin.token, appId);
    return { appId, defId: result.deficienciesCreated[0].id as string };
  };
  // A fresh deficiency with evidence uploaded, ready to verify.
  const withEvidence = async () => {
    const d = await freshDeficiency();
    const up = await api(instUser.token, "POST", `/deficiencies/${d.defId}/evidence`, form(file("e.pdf", "application/pdf")));
    assert.equal(up.status, 201, up.raw);
    return { ...d, evidenceId: up.body.evidence.id as string };
  };
  const alertFor = async (userId: string) =>
    (await createAlert(userId, "STATUS_CHANGE", "RBAC test alert (fictional)", null, uniqueCode("TEST")))!.id;

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
    officer2 = await seeded("officer2");
    inst1 = await seeded("inst1"); // linked to seeded FIC-001: "another college"
    const inst = await createInstitution(admin, "RBAC", { labCount: 4 });
    institutionId = inst.id;
    instUser = await createInstitutionUser("rbac-registrar@niyamsetu.test", institutionId, officer1.user.id);
    spareEmail = "rbac-spare@niyamsetu.test";
    await createInstitutionUser(spareEmail, null, officer1.user.id);
  });

  // Every write route × every role. Each call builds its own fixture so the roles don't interfere.
  const matrix: { route: string; expect: Record<Role, number>; call: (s: Session) => Promise<number> }[] = [
    {
      route: "POST /api/institutions",
      expect: { ADMIN: 201, OFFICER: 403, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "POST", "/institutions", institutionBody(uniqueCode("RBI")))).status,
    },
    {
      route: "POST /api/users/link-institution",
      expect: { ADMIN: 200, OFFICER: 403, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "POST", "/users/link-institution", { email: spareEmail, institutionId })).status,
    },
    {
      route: "POST /api/applications",
      expect: { ADMIN: 201, OFFICER: 403, INSTITUTION: 201 },
      call: async (s) =>
        (await api(s.token, "POST", "/applications", { programme: "B.Tech RBAC", academicYear: "2027-28", institutionId })).status,
    },
    {
      route: "POST /api/applications/:id/assign",
      expect: { ADMIN: 200, OFFICER: 403, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "POST", `/applications/${await freshApp()}/assign`, { officerId: officer2.user.id })).status,
    },
    {
      route: "PATCH /api/applications/:id/stage",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "PATCH", `/applications/${await freshApp()}/stage`, { toStage: "SCRUTINY" })).status,
    },
    {
      route: "PATCH /api/applications/:id/expert-visit",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 403 },
      call: async (s) => {
        const id = await freshApp();
        await api(admin.token, "PATCH", `/applications/${id}/stage`, { toStage: "SCRUTINY" });
        return (await api(s.token, "PATCH", `/applications/${id}/expert-visit`, {
          expertVisitDate: daysFromNow(5),
          expertNames: "Dr. Test Expert (fictional)",
        })).status;
      },
    },
    {
      route: "POST /api/applications/:id/check",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 200 },
      call: async (s) => (await api(s.token, "POST", `/applications/${await freshApp()}/check`)).status,
    },
    {
      route: "PATCH /api/deficiencies/:id/assign",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "PATCH", `/deficiencies/${(await freshDeficiency()).defId}/assign`, { dueDate: daysFromNow(3) })).status,
    },
    {
      route: "POST /api/deficiencies/:id/evidence",
      expect: { ADMIN: 403, OFFICER: 403, INSTITUTION: 201 },
      call: async (s) =>
        (await api(s.token, "POST", `/deficiencies/${(await freshDeficiency()).defId}/evidence`, form(file("e.pdf", "application/pdf")))).status,
    },
    {
      route: "PATCH /api/deficiencies/:id/verify",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "PATCH", `/deficiencies/${(await withEvidence()).defId}/verify`, { decision: "VERIFIED" })).status,
    },
    {
      route: "POST /api/admin/run-deadline-check",
      expect: { ADMIN: 200, OFFICER: 403, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "POST", "/admin/run-deadline-check")).status,
    },
    {
      route: "PATCH /api/alerts/:id/read (own alert)",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 200 },
      call: async (s) => (await api(s.token, "PATCH", `/alerts/${await alertFor(s.user.id)}/read`)).status,
    },
    {
      route: "PATCH /api/alerts/:id/read (someone else's alert)",
      expect: { ADMIN: 403, OFFICER: 403, INSTITUTION: 403 },
      call: async (s) => (await api(s.token, "PATCH", `/alerts/${await alertFor(officer2.user.id)}/read`)).status,
    },
    {
      route: "PATCH /api/alerts/read-all",
      expect: { ADMIN: 200, OFFICER: 200, INSTITUTION: 200 },
      call: async (s) => (await api(s.token, "PATCH", "/alerts/read-all")).status,
    },
  ];

  for (const row of matrix) {
    for (const role of ROLES) {
      it(`${row.route} as ${role} → ${row.expect[role]}`, async () => {
        assert.equal(await row.call(as[role]()), row.expect[role]);
      });
    }
  }

  it("GET /api/dashboard/workload is ADMIN only", async () => {
    assert.equal((await api(admin.token, "GET", "/dashboard/workload")).status, 200);
    assert.equal((await api(officer1.token, "GET", "/dashboard/workload")).status, 403);
    assert.equal((await api(instUser.token, "GET", "/dashboard/workload")).status, 403);
  });

  it("an officer NOT assigned to the application gets 403 on every read and write", async () => {
    const { appId, defId } = await withEvidence();
    const o2 = officer2.token;
    const calls = [
      api(o2, "GET", `/applications/${appId}`),
      api(o2, "PATCH", `/applications/${appId}/stage`, { toStage: "SCRUTINY" }),
      api(o2, "PATCH", `/applications/${appId}/expert-visit`, { expertVisitDate: daysFromNow(5), expertNames: "x" }),
      api(o2, "POST", `/applications/${appId}/check`),
      api(o2, "GET", `/applications/${appId}/checks`),
      api(o2, "GET", `/applications/${appId}/audit`),
      api(o2, "GET", `/deficiencies/${defId}`),
      api(o2, "PATCH", `/deficiencies/${defId}/assign`, { dueDate: daysFromNow(3) }),
      api(o2, "PATCH", `/deficiencies/${defId}/verify`, { decision: "VERIFIED" }),
      api(o2, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf"))),
    ];
    const statuses = (await Promise.all(calls)).map((r) => r.status);
    assert.deepEqual(statuses, statuses.map(() => 403));
    const d = await prisma.deficiency.findUniqueOrThrow({ where: { id: defId } });
    assert.equal(d.status, "EVIDENCE_SUBMITTED"); // nothing changed
  });

  it("an institution user from ANOTHER college gets 403 on every read and write", async () => {
    const { appId, defId, evidenceId } = await withEvidence();
    const t = inst1.token;
    const calls = [
      api(t, "GET", `/applications/${appId}`),
      api(t, "POST", `/applications/${appId}/check`),
      api(t, "GET", `/applications/${appId}/checks`),
      api(t, "GET", `/applications/${appId}/audit`),
      api(t, "GET", `/deficiencies/${defId}`),
      api(t, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf"))),
      api(t, "GET", `/evidence/${evidenceId}/file`),
    ];
    const statuses = (await Promise.all(calls)).map((r) => r.status);
    assert.deepEqual(statuses, statuses.map(() => 403));
  });

  it("another college's data never appears in list endpoints", async () => {
    const { appId, defId } = await freshDeficiency();
    const apps = await api(inst1.token, "GET", "/applications");
    assert.ok(!apps.body.applications.some((a: any) => a.id === appId));
    const defs = await api(inst1.token, "GET", "/deficiencies");
    assert.ok(!defs.body.deficiencies.some((d: any) => d.id === defId));
    const insts = await api(inst1.token, "GET", "/institutions");
    assert.ok(!insts.body.institutions.some((i: any) => i.id === institutionId));
  });

  it("no token or a bad token → 401", async () => {
    assert.equal((await api(null, "GET", "/applications")).status, 401);
    assert.equal((await api(null, "POST", "/institutions", institutionBody(uniqueCode("X")))).status, 401);
    assert.equal((await api("not.a.jwt", "GET", "/dashboard/summary")).status, 401);
  });
});
