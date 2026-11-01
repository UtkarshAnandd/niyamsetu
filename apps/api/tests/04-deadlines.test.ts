import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, alertByKey, check, createApplication, createInstitution, createInstitutionUser, prisma, seeded, shared,
  type Session,
} from "./helpers";
import { runDeadlineCheck, windows } from "../src/jobs/deadlines";

const S = 1000;
const M = 60 * S;

type Case = {
  label: string;
  defId: string;
  offset: number; // due date relative to the injected time T
  owner: string | null;
  officer: string | null;
  ownerManager: string | null;
  officerManager: string | null;
};

describe("4. Deadline engine (injected time)", () => {
  let admin: Session, officer1: Session, registrar: Session;
  let adminIds: string[];
  const cases: Case[] = [];
  let T: number; // injected "now", 30 minutes in the future
  const { dueSoonMs, graceMs } = windows();

  // One application + check per deficiency (the college fails MIN_LABS only).
  const makeDeficiency = async (institutionId: string, officerId: string | undefined) => {
    const appId = await createApplication(admin, institutionId, officerId);
    return (await check(admin.token, appId)).deficienciesCreated[0];
  };

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
    adminIds = (await prisma.user.findMany({ where: { role: "ADMIN" }, orderBy: { id: "asc" } })).map((u) => u.id);
    T = Date.now() + 30 * M;

    // College with a registrar (owner) whose manager is officer1.
    const owned = await createInstitution(admin, "DLN", { labCount: 5 });
    registrar = await createInstitutionUser("deadline-registrar@niyamsetu.test", owned.id, officer1.user.id);
    // College with no registrar: deficiencies have no owner.
    const unowned = await createInstitution(admin, "DLX", { labCount: 5 });

    const plan: { label: string; offset: number; inst: string; officer: boolean }[] = [
      { label: "overdue, past grace (−10 min)", offset: -10 * M, inst: owned.id, officer: true },
      { label: "overdue, past grace (−5 min)", offset: -5 * M, inst: owned.id, officer: true },
      { label: "overdue, past grace (−3 min)", offset: -3 * M, inst: owned.id, officer: true },
      { label: "overdue, within grace (−90 s)", offset: -90 * S, inst: owned.id, officer: true },
      { label: "overdue, within grace (−30 s)", offset: -30 * S, inst: owned.id, officer: true },
      { label: "due soon (+30 s)", offset: 30 * S, inst: owned.id, officer: true },
      { label: "due soon (+1 min)", offset: 1 * M, inst: owned.id, officer: true },
      { label: "due soon, window edge (+3 min)", offset: 3 * M, inst: owned.id, officer: true },
      { label: "not yet (+3 min 1 s)", offset: 3 * M + S, inst: owned.id, officer: true },
      { label: "not yet (+10 min)", offset: 10 * M, inst: owned.id, officer: true },
      { label: "no owner → assigned officer (−5 min)", offset: -5 * M, inst: unowned.id, officer: true },
      { label: "no owner, no officer → all admins (−5 min)", offset: -5 * M, inst: unowned.id, officer: false },
    ];
    for (const p of plan) {
      const d = await makeDeficiency(p.inst, p.officer ? officer1.user.id : undefined);
      const r = await api(admin.token, "PATCH", `/deficiencies/${d.id}/assign`, { dueDate: new Date(T + p.offset).toISOString() });
      assert.equal(r.status, 200, r.raw);
      cases.push({
        label: p.label,
        defId: d.id,
        offset: p.offset,
        owner: d.ownerId,
        officer: p.officer ? officer1.user.id : null,
        ownerManager: d.ownerId ? registrar.user.managerId : null,
        officerManager: p.officer ? officer1.user.managerId : null,
      });
    }
  });

  // What the engine should do for each case at time T.
  const expected = (c: Case) => {
    const due = T + c.offset;
    const overdue = due < T;
    const dueSoon = due > T && due <= T + dueSoonMs;
    const escalate = overdue && due < T - graceMs;
    // Recipient rule: the first candidate gets the plain key; with no candidate,
    // every admin gets "<key>:<adminId>".
    const alerts: { type: string; userId: string; key: string }[] = [];
    const add = (type: string, key: string, candidates: (string | null)[]) => {
      const first = candidates.find((x) => x);
      if (first) alerts.push({ type, userId: first, key });
      else for (const id of adminIds) alerts.push({ type, userId: id, key: `${key}:${id}` });
    };
    if (dueSoon) add("DUE_SOON", `DUE_SOON:${c.defId}:${due}`, [c.owner, c.officer]);
    if (overdue) add("OVERDUE", `OVERDUE:${c.defId}:${due}`, [c.owner, c.officer]);
    if (escalate) add("ESCALATION", `ESCALATION:${c.defId}:${due}`, [c.ownerManager, c.officerManager]);
    return { overdue, dueSoon, escalate, alerts };
  };

  it("one engine run at T classifies every deficiency correctly", async () => {
    await runDeadlineCheck(new Date(T));
    let correct = 0;
    const wrong: string[] = [];
    for (const c of cases) {
      const e = expected(c);
      const d = await prisma.deficiency.findUniqueOrThrow({ where: { id: c.defId } });
      const dueSoonAlert = await prisma.alert.count({ where: { deficiencyId: c.defId, type: "DUE_SOON" } });
      const ok =
        (d.status === "OVERDUE") === e.overdue &&
        (d.escalatedAt !== null) === e.escalate &&
        (dueSoonAlert > 0) === e.dueSoon &&
        (e.overdue || e.dueSoon || dueSoonAlert === 0);
      if (ok) correct++;
      else wrong.push(`${c.label}: status=${d.status} escalated=${d.escalatedAt !== null} dueSoonAlerts=${dueSoonAlert}`);
    }
    shared.metrics.deadlineDetection = {
      correct,
      total: cases.length,
      counts: {
        overdue: cases.filter((c) => expected(c).overdue).length,
        dueSoon: cases.filter((c) => expected(c).dueSoon).length,
        notYet: cases.filter((c) => !expected(c).overdue && !expected(c).dueSoon).length,
        escalate: cases.filter((c) => expected(c).escalate).length,
      },
      dueSoonWindow: `${dueSoonMs / M}-minute`,
      grace: `${graceMs / M}-minute`,
    };
    assert.deepEqual(wrong, []);
  });

  it("every expected alert went to the right recipient with the right type, and nothing else", async () => {
    const expectedAlerts = cases.flatMap((c) => expected(c).alerts);
    const actual = await prisma.alert.findMany({ where: { deficiencyId: { in: cases.map((c) => c.defId) } } });
    let correct = 0;
    const problems: string[] = [];
    for (const e of expectedAlerts) {
      const a = actual.find((x) => x.dedupKey === e.key);
      if (a && a.userId === e.userId && a.type === e.type) correct++;
      else problems.push(`missing/wrong: ${e.key} → ${e.userId}`);
    }
    const unexpected = actual.filter((a) => !expectedAlerts.some((e) => e.key === a.dedupKey));
    for (const u of unexpected) problems.push(`unexpected: ${u.dedupKey}`);
    shared.metrics.alertCorrectness = {
      expected: expectedAlerts.length,
      correct,
      unexpected: unexpected.length,
      extraRuns: 0,
      duplicates: null,
    };
    assert.deepEqual(problems, []);
  });

  it("5 more runs create no duplicate alerts and change nothing", async () => {
    const ids = cases.map((c) => c.defId);
    const before = await prisma.alert.count({ where: { deficiencyId: { in: ids } } });
    const statesBefore = await prisma.deficiency.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    // Same injected time: a later "now" could legitimately bring a new deficiency into the window.
    for (let i = 1; i <= 5; i++) await runDeadlineCheck(new Date(T));
    const after = await prisma.alert.count({ where: { deficiencyId: { in: ids } } });
    const statesAfter = await prisma.deficiency.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    const m = shared.metrics.alertCorrectness as any;
    m.extraRuns = 5;
    m.duplicates = after - before;
    assert.equal(after - before, 0);
    assert.deepEqual(
      statesAfter.map((d) => [d.status, d.escalatedAt?.getTime() ?? null]),
      statesBefore.map((d) => [d.status, d.escalatedAt?.getTime() ?? null])
    );
  });

  it("a new due date reopens an escalated deficiency and it can escalate again", async () => {
    const c = cases[0]; // escalated at T
    const oldDue = T + c.offset;
    const newDue = T + 20 * M;
    const r = await api(officer1.token, "PATCH", `/deficiencies/${c.defId}/assign`, { dueDate: new Date(newDue).toISOString() });
    assert.equal(r.status, 200);
    assert.equal(r.body.deficiency.status, "OPEN");
    assert.equal(r.body.deficiency.escalatedAt, null);

    await runDeadlineCheck(new Date(newDue + graceMs + S));
    const d = await prisma.deficiency.findUniqueOrThrow({ where: { id: c.defId } });
    assert.equal(d.status, "OVERDUE");
    assert.notEqual(d.escalatedAt, null);
    const escalations = await prisma.alert.findMany({ where: { deficiencyId: c.defId, type: "ESCALATION" }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(escalations.map((a) => a.dedupKey), [`ESCALATION:${c.defId}:${oldDue}`, `ESCALATION:${c.defId}:${newDue}`]);
    assert.ok(escalations.every((a) => a.userId === registrar.user.managerId));
  });

  it("expert visit (EVC) reminder goes to the assigned officer once", async () => {
    const inst = await createInstitution(admin, "EVC");
    const appId = await createApplication(admin, inst.id, officer1.user.id);
    const visit = T + 1 * M;
    await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "SCRUTINY" });
    await api(officer1.token, "PATCH", `/applications/${appId}/expert-visit`, {
      expertVisitDate: new Date(visit).toISOString(),
      expertNames: "Dr. Test Expert (fictional)",
    });
    await api(officer1.token, "PATCH", `/applications/${appId}/stage`, { toStage: "EXPERT_VISIT" });
    for (let i = 0; i < 3; i++) await runDeadlineCheck(new Date(T));
    const alert = await alertByKey(`EVC:${appId}:${visit}`);
    assert.equal(alert?.userId, officer1.user.id);
    assert.equal(await prisma.alert.count({ where: { dedupKey: { startsWith: `EVC:${appId}:` } } }), 1);
  });

  it("the HTTP fallback (POST /api/admin/run-deadline-check) returns the summary", async () => {
    const r = await api(admin.token, "POST", "/admin/run-deadline-check");
    assert.equal(r.status, 200);
    for (const k of ["dueSoon", "overdue", "escalated", "evcReminders"]) assert.equal(typeof r.body[k], "number");
    assert.ok(Array.isArray(r.body.details));
  });
});
