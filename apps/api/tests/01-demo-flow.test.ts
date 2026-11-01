import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, alertByKey, daysFromNow, file, form, institutionBody, minutesFromNow, prisma, seeded, uniqueCode,
  type Session,
} from "./helpers";
import { runDeadlineCheck } from "../src/jobs/deadlines";

describe("1. 9-step demo flow", () => {
  let admin: Session, officer1: Session, inst3: Session;
  let institutionId: string, appId: string, defId: string, dueMs: number;
  let firstEvidenceId: string;

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
  });

  it("step 1: ADMIN registers a fictional institution with an expired FIRE_NOC", async () => {
    const code = uniqueCode("DEMO");
    const body = institutionBody(code, {
      documents: [
        { docType: "LAND_DEED", fileName: "land-deed.pdf" },
        { docType: "BUILDING_PLAN", fileName: "building-plan.pdf" },
        { docType: "FIRE_NOC", fileName: "fire-noc.pdf", expiryDate: daysFromNow(-30) },
      ],
    });
    const r = await api(admin.token, "POST", "/institutions", body);
    assert.equal(r.status, 201);
    assert.equal(r.body.institution.code, code);
    assert.equal(r.body.institution.documents.length, 3);
    institutionId = r.body.institution.id;
  });

  it("step 1: ADMIN links inst3; after logging in again inst3 sees only its college", async () => {
    const r = await api(admin.token, "POST", "/users/link-institution", {
      email: "inst3@niyamsetu.test",
      institutionId,
    });
    assert.equal(r.status, 200);
    inst3 = await seeded("inst3");
    assert.equal(inst3.user.institutionId, institutionId);
    const list = await api(inst3.token, "GET", "/institutions");
    assert.deepEqual(list.body.institutions.map((i: any) => i.id), [institutionId]);
  });

  it("step 2: inst3 creates an application (SUBMITTED, first history row)", async () => {
    const r = await api(inst3.token, "POST", "/applications", {
      programme: "B.Tech Computer Science",
      academicYear: "2027-28",
    });
    assert.equal(r.status, 201);
    appId = r.body.application.id;
    assert.equal(r.body.application.institutionId, institutionId);
    const detail = await api(inst3.token, "GET", `/applications/${appId}`);
    assert.equal(detail.body.application.stage, "SUBMITTED");
    assert.equal(detail.body.application.stageHistory.length, 1);
    assert.equal(detail.body.application.stageHistory[0].fromStage, null);
  });

  it("step 2: ADMIN assigns officer1", async () => {
    const r = await api(admin.token, "POST", `/applications/${appId}/assign`, { officerId: officer1.user.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.application.assignedOfficerId, officer1.user.id);
  });

  it("step 3: inst3 checks the application against all 5 placeholder rules", async () => {
    const r = await api(inst3.token, "POST", `/applications/${appId}/check`);
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 5);
    const failed = r.body.results.filter((x: any) => !x.passed).map((x: any) => x.code);
    assert.deepEqual(failed, ["REQUIRED_DOCUMENTS"]);
    assert.equal(r.body.results.find((x: any) => x.code === "FACULTY_RATIO").version, 2);
    for (const x of r.body.results) assert.match(x.source, /placeholder/);
  });

  it("step 4: exactly one deficiency, traceable to the exact rule version", async () => {
    const defs = await prisma.deficiency.findMany({
      where: { applicationId: appId },
      include: { ruleCheck: { include: { rule: true } } },
    });
    assert.equal(defs.length, 1);
    const d = defs[0];
    defId = d.id;
    assert.match(d.requirement, /FIRE_NOC expired .*\(REQUIRED_DOCUMENTS v1\)/);
    assert.equal(d.status, "OPEN");
    assert.equal(d.ownerId, inst3.user.id);
    assert.equal(d.ruleCheck?.rule.code, "REQUIRED_DOCUMENTS");
    assert.equal(d.ruleCheck?.rule.version, 1);
  });

  it("step 5: officer1 sets owner and a due date 2 minutes ahead", async () => {
    const due = minutesFromNow(2);
    const r = await api(officer1.token, "PATCH", `/deficiencies/${defId}/assign`, {
      ownerId: inst3.user.id,
      dueDate: due,
    });
    assert.equal(r.status, 200);
    dueMs = new Date(r.body.deficiency.dueDate).getTime();
    assert.equal(dueMs, new Date(due).getTime());
  });

  it("step 6: deadline engine sends DUE_SOON to the owner (injected time: 1 min before due)", async () => {
    await runDeadlineCheck(new Date(dueMs - 60_000));
    const alert = await alertByKey(`DUE_SOON:${defId}:${dueMs}`);
    assert.equal(alert?.userId, inst3.user.id);
    assert.equal(alert?.type, "DUE_SOON");
  });

  it("step 6: after the due date it marks OVERDUE and alerts the owner", async () => {
    await runDeadlineCheck(new Date(dueMs + 1000));
    const d = await prisma.deficiency.findUniqueOrThrow({ where: { id: defId } });
    assert.equal(d.status, "OVERDUE");
    assert.equal(d.escalatedAt, null);
    assert.equal((await alertByKey(`OVERDUE:${defId}:${dueMs}`))?.userId, inst3.user.id);
  });

  it("step 6: after the 2-minute grace period it escalates once to the owner's manager", async () => {
    await runDeadlineCheck(new Date(dueMs + 2 * 60_000 + 1000));
    const d = await prisma.deficiency.findUniqueOrThrow({ where: { id: defId } });
    assert.notEqual(d.escalatedAt, null);
    const alert = await alertByKey(`ESCALATION:${defId}:${dueMs}`);
    assert.equal(alert?.userId, inst3.user.managerId);
    assert.equal(alert?.userId, officer1.user.id);
  });

  it("step 7: inst3 uploads fictional evidence → EVIDENCE_SUBMITTED, officer alerted", async () => {
    const r = await api(inst3.token, "POST", `/deficiencies/${defId}/evidence`,
      form(file("fire-noc-receipt.pdf", "application/pdf"), "Renewal receipt (fictional)"));
    assert.equal(r.status, 201);
    assert.equal(r.body.deficiency.status, "EVIDENCE_SUBMITTED");
    assert.equal(r.body.alertedRole, "OFFICER");
    firstEvidenceId = r.body.evidence.id;
    assert.equal((await alertByKey(`EVIDENCE:${firstEvidenceId}`))?.userId, officer1.user.id);
  });

  it("step 8: officer1 moves to COMMITTEE; APPROVED is blocked while the deficiency is open", async () => {
    assert.equal((await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "SCRUTINY" })).status, 200);
    const visit = await api(officer1.token, "PATCH", `/applications/${appId}/expert-visit`, {
      expertVisitDate: daysFromNow(2),
      expertNames: "Dr. Example Expert (fictional)",
    });
    assert.equal(visit.status, 200);
    assert.equal((await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "EXPERT_VISIT" })).status, 200);
    assert.equal((await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "COMMITTEE" })).status, 200);
    const blocked = await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "APPROVED" });
    assert.equal(blocked.status, 400);
    assert.deepEqual(blocked.body.pendingDeficiencies.map((p: any) => p.id), [defId]);
  });

  it("step 8: officer1 rejects with a remark; inst3 sees the reason", async () => {
    const remark = "Receipt only – upload the issued Fire NOC";
    const r = await api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "REJECTED", remark });
    assert.equal(r.status, 200);
    assert.equal(r.body.deficiency.status, "REJECTED");
    assert.equal(r.body.deficiency.escalatedAt, null);
    assert.ok(new Date(r.body.deficiency.dueDate).getTime() > Date.now());
    const view = await api(inst3.token, "GET", `/deficiencies/${defId}`);
    assert.equal(view.body.deficiency.evidence[0].reviewRemark, remark);
    assert.equal((await alertByKey(`REJECTED:${firstEvidenceId}`))?.userId, inst3.user.id);
  });

  it("step 8: inst3 re-uploads and officer1 verifies", async () => {
    const up = await api(inst3.token, "POST", `/deficiencies/${defId}/evidence`,
      form(file("fire-noc-renewed.png", "image/png")));
    assert.equal(up.status, 201);
    const v = await api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "VERIFIED", remark: "Checked" });
    assert.equal(v.status, 200);
    assert.equal(v.body.deficiency.status, "VERIFIED");
    assert.equal(v.body.evidence.id, up.body.evidence.id);
    assert.equal(v.body.evidence.verifiedById, officer1.user.id);
    assert.ok(v.body.evidence.verifiedAt);
  });

  it("step 8: the application moves to APPROVED with a full stage history", async () => {
    const r = await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "APPROVED" });
    assert.equal(r.status, 200);
    const detail = await api(inst3.token, "GET", `/applications/${appId}`);
    assert.deepEqual(
      detail.body.application.stageHistory.map((h: any) => h.toStage),
      ["SUBMITTED", "SCRUTINY", "EXPERT_VISIT", "COMMITTEE", "APPROVED"]
    );
  });

  it("step 9: the application's audit trail records every step", async () => {
    const r = await api(inst3.token, "GET", `/applications/${appId}/audit?limit=200`);
    assert.equal(r.status, 200);
    assert.equal(r.body.total, r.body.audit.length);
    const count = (entityType: string, action: string, actor?: "System") =>
      r.body.audit.filter((a: any) => a.entityType === entityType && a.action === action &&
        (actor ? a.actorName === actor : true)).length;
    assert.equal(count("Application", "CREATE"), 1);
    assert.equal(count("Application", "UPDATE"), 2); // assignment + expert visit
    assert.equal(count("Application", "STATUS_CHANGE"), 4);
    assert.equal(count("RuleCheck", "CREATE"), 1);
    assert.equal(count("Deficiency", "CREATE"), 1);
    assert.equal(count("Deficiency", "STATUS_CHANGE", "System"), 1); // OVERDUE
    assert.equal(count("Deficiency", "UPDATE", "System"), 1); // escalation
    assert.equal(count("Deficiency", "STATUS_CHANGE"), 5); // OVERDUE, submitted ×2, REJECTED, VERIFIED
    assert.equal(count("Evidence", "CREATE"), 2);
    assert.equal(count("Evidence", "UPDATE"), 2); // reject + verify
  });

  it("step 9: dashboard numbers equal live database counts", async () => {
    const r = await api(admin.token, "GET", "/dashboard/summary");
    assert.equal(r.status, 200);
    const now = new Date();
    const notVerified = { status: { not: "VERIFIED" as const } };
    assert.equal(r.body.applications, await prisma.application.count());
    assert.equal(r.body.openDeficiencies, await prisma.deficiency.count({ where: notVerified }));
    assert.equal(r.body.escalated, await prisma.deficiency.count({ where: { ...notVerified, escalatedAt: { not: null } } }));
    assert.equal(r.body.unassignedDeficiencies, await prisma.deficiency.count({ where: { ...notVerified, ownerId: null } }));
    assert.equal(r.body.overdue, await prisma.deficiency.count({
      where: { OR: [{ status: "OVERDUE" }, { status: { in: ["OPEN", "REJECTED"] }, dueDate: { lt: now } }] },
    }));
    for (const [stage, n] of Object.entries(r.body.byStage)) {
      assert.equal(n, await prisma.application.count({ where: { stage: stage as any } }), stage);
    }
    const mine = await api(inst3.token, "GET", "/dashboard/summary");
    assert.equal(mine.body.applications, 1);
    assert.equal(mine.body.byStage.APPROVED, 1);
    assert.equal(mine.body.openDeficiencies, 0);
  });
});
