import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import {
  api, apiBytes, check, createApplication, createInstitution, createInstitutionUser, file, form, prisma,
  seeded, uploadsOnDisk, type Session,
} from "./helpers";

const FIVE_MB = 5 * 1024 * 1024;

describe("5. Evidence upload", () => {
  let admin: Session, officer1: Session, inst1: Session, registrar: Session;
  let institutionId: string;

  before(async () => {
    admin = await seeded("admin1");
    officer1 = await seeded("officer1");
    inst1 = await seeded("inst1");
    const inst = await createInstitution(admin, "EVD", { labCount: 5 });
    institutionId = inst.id;
    registrar = await createInstitutionUser("evidence-registrar@niyamsetu.test", inst.id, officer1.user.id);
  });

  const freshDeficiency = async () => {
    const appId = await createApplication(admin, institutionId, officer1.user.id);
    return (await check(admin.token, appId)).deficienciesCreated[0].id as string;
  };

  // A rejected upload must leave no Evidence row, no file and no status change.
  const assertRejected = async (defId: string, f: File | undefined, status: number, message: RegExp) => {
    const filesBefore = uploadsOnDisk();
    const r = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(f, "test note"));
    assert.equal(r.status, status, r.raw);
    assert.match(r.body.error, message);
    assert.equal(uploadsOnDisk(), filesBefore, "a file was left in uploads/");
    assert.equal(await prisma.evidence.count({ where: { deficiencyId: defId } }), 0);
    assert.equal((await prisma.deficiency.findUniqueOrThrow({ where: { id: defId } })).status, "OPEN");
  };

  it("a .txt file → 400, nothing stored", async () => {
    await assertRejected(await freshDeficiency(), file("notes.txt", "text/plain"), 400, /Only PDF, PNG or JPG/);
  });

  it("a .exe file → 400, nothing stored", async () => {
    await assertRejected(await freshDeficiency(), file("setup.exe", "application/octet-stream"), 400, /Only PDF, PNG or JPG/);
  });

  it("a .pdf name with a non-PDF mimetype → 400", async () => {
    await assertRejected(await freshDeficiency(), file("fake.pdf", "image/png"), 400, /Only PDF, PNG or JPG/);
  });

  it("a PDF of 5 MB + 1 byte → 400, partial file removed", async () => {
    await assertRejected(await freshDeficiency(), file("big.pdf", "application/pdf", FIVE_MB + 1), 400, /File too large/);
  });

  it("no file in the form → 400", async () => {
    await assertRejected(await freshDeficiency(), undefined, 400, /File is required/);
  });

  it("a PDF of exactly 5 MB is accepted", async () => {
    const defId = await freshDeficiency();
    const r = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("max.pdf", "application/pdf", FIVE_MB)));
    assert.equal(r.status, 201);
  });

  it("PNG and JPG are accepted and download back byte-for-byte with the right type", async () => {
    const defId = await freshDeficiency();
    for (const [name, type] of [["photo.png", "image/png"], ["scan.jpg", "image/jpeg"]]) {
      const f = file(name, type, 1234);
      const r = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(f));
      assert.equal(r.status, 201, r.raw);
      const dl = await apiBytes(officer1.token, `/evidence/${r.body.evidence.id}/file`);
      assert.equal(dl.status, 200);
      assert.equal(dl.type, type);
      assert.deepEqual(dl.bytes, Buffer.from(await f.arrayBuffer()));
    }
  });

  it("another college's user → 403 and no file written", async () => {
    const defId = await freshDeficiency();
    const filesBefore = uploadsOnDisk();
    const r = await api(inst1.token, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf")));
    assert.equal(r.status, 403);
    assert.equal(uploadsOnDisk(), filesBefore);
  });

  it("rejecting requires a remark → 400 with issues", async () => {
    const defId = await freshDeficiency();
    await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf")));
    const r = await api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "REJECTED" });
    assert.equal(r.status, 400);
    assert.equal(r.body.issues[0].path, "remark");
  });

  it("verify without submitted evidence → 400", async () => {
    const defId = await freshDeficiency();
    const r = await api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "VERIFIED" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /status is OPEN/);
  });

  it("upload after VERIFIED → 400, and verify again → 400", async () => {
    const defId = await freshDeficiency();
    await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf")));
    assert.equal((await api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "VERIFIED" })).status, 200);
    const filesBefore = uploadsOnDisk();
    const again = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("late.pdf", "application/pdf")));
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already verified/);
    assert.equal(uploadsOnDisk(), filesBefore);
    assert.equal(await prisma.evidence.count({ where: { deficiencyId: defId } }), 1);
    assert.equal((await api(officer1.token, "PATCH", `/deficiencies/${defId}/verify`, { decision: "VERIFIED" })).status, 400);
  });

  it("an OVERDUE deficiency still accepts evidence", async () => {
    const defId = await freshDeficiency();
    await prisma.deficiency.update({ where: { id: defId }, data: { status: "OVERDUE" } }); // test fixture
    const r = await api(registrar.token, "POST", `/deficiencies/${defId}/evidence`, form(file("e.pdf", "application/pdf")));
    assert.equal(r.status, 201);
    assert.equal(r.body.deficiency.status, "EVIDENCE_SUBMITTED");
  });
});
