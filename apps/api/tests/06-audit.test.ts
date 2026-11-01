import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, auditCount, createInstitutionUser, daysFromNow, file, form, institutionBody, latestAudit, minutesFromNow,
  prisma, seeded, uniqueCode, type Session,
} from "./helpers";
import { runDeadlineCheck } from "../src/jobs/deadlines";
import { createAlert } from "../src/services/alerts";

// Runs fn and returns how many audit rows it added.
async function delta(fn: () => Promise<unknown>) {
  const before = await auditCount();
  await fn();
  return (await auditCount()) - before;
}

describe("6. Audit log", () => {
  let admin: Session, officer1: Session, registrar: Session;
  let institutionId: string, appId: string, defId: string, evidenceId: string;

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
  });

  it("login → one LOGIN row for that user", async () => {
    let session!: Session;
    assert.equal(await delta(async () => { session = await seeded("officer2"); }), 1);
    const row = await latestAudit("User", session.user.id, "LOGIN");
    assert.equal(row?.actorId, session.user.id);
    assert.equal((row?.after as any).email, "officer2@niyamsetu.test");
  });

  it("create institution → one Institution CREATE row by the admin", async () => {
    let id = "";
    const n = await delta(async () => {
      const r = await api(admin.token, "POST", "/institutions", institutionBody(uniqueCode("AUD"), { labCount: 5 }));
      id = r.body.institution.id;
    });
    assert.equal(n, 1);
    institutionId = id;
    const row = await latestAudit("Institution", id, "CREATE");
    assert.equal(row?.actorId, admin.user.id);
    assert.equal((row?.after as any).labCount, 5);
  });

  it("link institution → one User UPDATE row with before/after institutionId", async () => {
    registrar = await createInstitutionUser("audit-registrar@niyamsetu.test", null, officer1.user.id);
    const n = await delta(() => api(admin.token, "POST", "/users/link-institution", { email: "audit-registrar@niyamsetu.test", institutionId }));
    assert.equal(n, 1);
    const row = await latestAudit("User", registrar.user.id, "UPDATE");
    assert.deepEqual([(row?.before as any).institutionId, (row?.after as any).institutionId], [null, institutionId]);
    registrar = await seeded("audit-registrar"); // fresh token with the new institutionId
  });

  it("create application → one Application CREATE row by the institution user", async () => {
    const n = await delta(async () => {
      const r = await api(registrar.token, "POST", "/applications", { programme: "B.Tech Audit", academicYear: "2027-28" });
      appId = r.body.application.id;
    });
    assert.equal(n, 1);
    assert.equal((await latestAudit("Application", appId, "CREATE"))?.actorId, registrar.user.id);
  });

  it("assign officer → one Application UPDATE row with before/after", async () => {
    assert.equal(await delta(() => api(admin.token, "POST", `/applications/${appId}/assign`, { officerId: officer1.user.id })), 1);
    const row = await latestAudit("Application", appId, "UPDATE");
    assert.deepEqual([(row?.before as any).assignedOfficerId, (row?.after as any).assignedOfficerId], [null, officer1.user.id]);
  });

  it("stage change → one Application STATUS_CHANGE row", async () => {
    assert.equal(await delta(() => api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "SCRUTINY" })), 1);
    const row = await latestAudit("Application", appId, "STATUS_CHANGE");
    assert.deepEqual([(row?.before as any).stage, (row?.after as any).stage, row?.actorId], ["SUBMITTED", "SCRUTINY", officer1.user.id]);
  });

  it("expert visit → one Application UPDATE row", async () => {
    const n = await delta(() => api(officer1.token, "PATCH", `/applications/${appId}/expert-visit`, {
      expertVisitDate: daysFromNow(4), expertNames: "Dr. Audit Expert (fictional)",
    }));
    assert.equal(n, 1);
    assert.equal(((await latestAudit("Application", appId, "UPDATE"))?.after as any).expertNames, "Dr. Audit Expert (fictional)");
  });

  it("rule check → one RuleCheck summary row + one Deficiency CREATE row", async () => {
    const n = await delta(async () => {
      const r = await api(officer1.token, "POST", `/applications/${appId}/check`);
      defId = r.body.deficienciesCreated[0].id;
    });
    assert.equal(n, 2);
    const run = await latestAudit("RuleCheck", appId, "CREATE");
    assert.equal((run?.after as any).summary.length, 5);
    assert.equal((run?.after as any).deficienciesCreated, 1);
    assert.equal((await latestAudit("Deficiency", defId, "CREATE"))?.actorId, officer1.user.id);
  });

  it("deficiency assign → one Deficiency UPDATE row", async () => {
    const due = minutesFromNow(30);
    assert.equal(await delta(() => api(officer1.token, "PATCH", `/deficiencies/${defId}/assign`, { dueDate: due })), 1);
    const row = await latestAudit("Deficiency", defId, "UPDATE");
    assert.equal(new Date((row?.after as any).dueDate).toISOString(), due);
  });

  it("evidence upload → Evidence CREATE + Deficiency STATUS_CHANGE + Alert CREATE (system)", async () => {
    const n = await delta(async () => {
      const r = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf")));
      evidenceId = r.body.evidence.id;
    });
    assert.equal(n, 3);
    assert.equal((await latestAudit("Evidence", evidenceId, "CREATE"))?.actorId, registrar.user.id);
    const sc = await latestAudit("Deficiency", defId, "STATUS_CHANGE");
    assert.deepEqual([(sc?.before as any).status, (sc?.after as any).status], ["OPEN", "EVIDENCE_SUBMITTED"]);
    const alert = await prisma.alert.findUniqueOrThrow({ where: { dedupKey: `EVIDENCE:${evidenceId}` } });
    assert.equal((await latestAudit("Alert", alert.id, "CREATE"))?.actorId, null);
  });

  it("reject → Evidence UPDATE (remark) + Deficiency STATUS_CHANGE + Alert CREATE", async () => {
    const n = await delta(() => api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "REJECTED", remark: "Unclear scan" }));
    assert.equal(n, 3);
    assert.equal(((await latestAudit("Evidence", evidenceId, "UPDATE"))?.after as any).reviewRemark, "Unclear scan");
    const sc = await latestAudit("Deficiency", defId, "STATUS_CHANGE");
    assert.deepEqual([(sc?.after as any).status, (sc?.after as any).remark], ["REJECTED", "Unclear scan"]);
  });

  it("deadline engine → system STATUS_CHANGE (OVERDUE) and UPDATE (escalation), actor null", async () => {
    const d = await prisma.deficiency.findUniqueOrThrow({ where: { id: defId } });
    const due = d.dueDate!.getTime();
    await runDeadlineCheck(new Date(due + 1000));
    const overdue = await latestAudit("Deficiency", defId, "STATUS_CHANGE");
    assert.deepEqual([overdue?.actorId, (overdue?.after as any).status], [null, "OVERDUE"]);
    await runDeadlineCheck(new Date(due + 3 * 60 * 1000));
    const esc = await latestAudit("Deficiency", defId, "UPDATE");
    assert.equal(esc?.actorId, null);
    assert.ok((esc?.after as any).escalatedAt);
  });

  it("new due date on an OVERDUE deficiency → one STATUS_CHANGE row (reopened) by the officer", async () => {
    assert.equal(await delta(() => api(officer1.token, "PATCH", `/deficiencies/${defId}/assign`, { dueDate: minutesFromNow(60) })), 1);
    const row = await latestAudit("Deficiency", defId, "STATUS_CHANGE");
    assert.deepEqual([row?.actorId, (row?.before as any).status, (row?.after as any).status, (row?.after as any).escalatedAt],
      [officer1.user.id, "OVERDUE", "OPEN", null]);
  });

  it("verify → Evidence UPDATE (verifier) + Deficiency STATUS_CHANGE + Alert CREATE", async () => {
    const up = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("e2.pdf", "application/pdf")));
    const n = await delta(() => api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "VERIFIED" }));
    assert.equal(n, 3);
    const ev = await latestAudit("Evidence", up.body.evidence.id, "UPDATE");
    assert.equal((ev?.after as any).verifiedById, officer1.user.id);
    assert.equal(((await latestAudit("Deficiency", defId, "STATUS_CHANGE"))?.after as any).status, "VERIFIED");
  });

  it("alert read receipts write NO audit rows", async () => {
    const mine = await createAlert(registrar.user.id, "STATUS_CHANGE", "Audit test alert (fictional)", null, uniqueCode("TEST"));
    assert.equal(await delta(() => api(registrar.token, "PATCH", `/alerts/${mine!.id}/read`)), 0);
    assert.equal(await delta(() => api(registrar.token, "PATCH", "/alerts/read-all")), 0);
    assert.equal(await delta(() => api(officer1.token, "PATCH", "/alerts/read-all")), 0);
  });

  it("GET requests write NO audit rows", async () => {
    const n = await delta(async () => {
      for (const p of ["/applications", `/applications/${appId}`, `/applications/${appId}/checks`, "/deficiencies",
        `/deficiencies/${defId}`, "/alerts", "/alerts/history", "/dashboard/summary", "/audit", `/applications/${appId}/audit`]) {
        assert.equal((await api(officer1.token, "GET", p)).status, 200, p);
      }
    });
    assert.equal(n, 0);
  });

  it("refused writes (403 / 400) write NO audit rows", async () => {
    const n = await delta(async () => {
      assert.equal((await api(registrar.token, "PATCH", `/applications/${appId}/stage`, { toStage: "EXPERT_VISIT" })).status, 403);
      assert.equal((await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "APPROVED" })).status, 400);
      assert.equal((await api(officer1.token, "PATCH", `/deficiencies/${defId}/assign`, { dueDate: "2020-01-01" })).status, 400);
      assert.equal((await api(null, "POST", "/auth/login", { email: "admin1@niyamsetu.test", password: "wrong" })).status, 401);
    });
    assert.equal(n, 0);
  });

  it("GET /api/audit names system rows 'System' and users by name", async () => {
    const r = await api(admin.token, "GET", `/audit?entityType=Deficiency&entityId=${defId}&limit=200`);
    assert.ok(r.body.audit.some((a: any) => a.actorId === null && a.actorName === "System"));
    assert.ok(r.body.audit.some((a: any) => a.actorId === officer1.user.id && a.actorName === "Chitra Officer (fictional)"));
    assert.equal(r.body.total, await prisma.auditLog.count({ where: { entityType: "Deficiency", entityId: defId } }));
  });
});
