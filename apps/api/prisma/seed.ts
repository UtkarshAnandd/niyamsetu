// NiyamSetu seed data. EVERYTHING here is fictional: no real institutions,
// people or AICTE norms. Rule thresholds are placeholders.
import { PrismaClient, ApplicationStage, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEMO_PASSWORD } from "./demo-password";

const prisma = new PrismaClient();

const PLACEHOLDER_SOURCE = "placeholder – not a real AICTE norm";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysFromNow = (n: number) => new Date(now.getTime() + n * DAY);

async function clearAll() {
  // Children first so foreign keys are never violated.
  await prisma.auditLog.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.evidence.deleteMany();
  await prisma.deficiency.deleteMany();
  await prisma.ruleCheck.deleteMany();
  await prisma.applicationStageHistory.deleteMany();
  await prisma.application.deleteMany();
  await prisma.institutionDocument.deleteMany();
  await prisma.user.updateMany({ data: { managerId: null } });
  await prisma.user.deleteMany();
  await prisma.institution.deleteMany();
  await prisma.complianceRule.deleteMany();
}

async function seedRules() {
  await prisma.complianceRule.createMany({
    data: [
      // FACULTY_RATIO has two versions to show that rules are never overwritten.
      {
        code: "FACULTY_RATIO",
        version: 1,
        title: "Student to faculty ratio",
        source: PLACEHOLDER_SOURCE,
        effectiveFrom: new Date("2024-07-01"),
        effectiveTo: new Date("2026-06-30"),
        params: { maxStudentsPerFaculty: 15, evidenceNeeded: "Appointment letters and salary statements for additional faculty to reach 1:15" },
      },
      {
        code: "FACULTY_RATIO",
        version: 2,
        title: "Student to faculty ratio",
        source: PLACEHOLDER_SOURCE,
        effectiveFrom: new Date("2026-07-01"),
        params: { maxStudentsPerFaculty: 20, evidenceNeeded: "Appointment letters and salary statements for additional faculty to reach 1:20" },
      },
      {
        code: "MIN_BUILTUP_AREA",
        version: 1,
        title: "Minimum built-up area per student",
        source: PLACEHOLDER_SOURCE,
        effectiveFrom: new Date("2024-07-01"),
        params: { minSqmPerStudent: 10, evidenceNeeded: "Approved building plan and completion certificate showing the added built-up area" },
      },
      {
        code: "MIN_LAND_AREA",
        version: 1,
        title: "Minimum land area",
        source: PLACEHOLDER_SOURCE,
        effectiveFrom: new Date("2024-07-01"),
        params: { minAcres: 2.5, evidenceNeeded: "Registered land deed or lease for the additional land" },
      },
      {
        code: "MIN_LABS",
        version: 1,
        title: "Minimum number of laboratories",
        source: PLACEHOLDER_SOURCE,
        effectiveFrom: new Date("2024-07-01"),
        params: { minLabs: 6, evidenceNeeded: "Lab equipment purchase invoices and geo-tagged photos of each new lab" },
      },
      {
        code: "REQUIRED_DOCUMENTS",
        version: 1,
        title: "Mandatory documents present and not expired",
        source: PLACEHOLDER_SOURCE,
        effectiveFrom: new Date("2024-07-01"),
        params: {
          docTypes: ["LAND_DEED", "BUILDING_PLAN", "FIRE_NOC"],
          evidenceNeeded: "Upload the missing or renewed document with a valid expiry date",
        },
      },
    ],
  });
}

// Thresholds above: ratio <= 20, >= 10 sqm/student, >= 2.5 acres, >= 6 labs,
// LAND_DEED + BUILDING_PLAN + FIRE_NOC present and in date.
type FireNoc = "valid" | "missing" | "expired";
const institutionData: {
  code: string;
  name: string;
  state: string;
  city: string;
  type: string;
  studentIntake: number;
  facultyCount: number;
  builtUpAreaSqm: number;
  landAreaAcres: number;
  labCount: number;
  fireNoc: FireNoc;
}[] = [
  // ---- 6 institutions that pass every rule ----
  { code: "FIC-001", name: "Vindhyachal Institute of Technology", state: "Madhya Pradesh", city: "Fictionpur", type: "Engineering", studentIntake: 300, facultyCount: 18, builtUpAreaSqm: 3600, landAreaAcres: 4.0, labCount: 10, fireNoc: "valid" },
  { code: "FIC-002", name: "Saraswati Valley College of Engineering", state: "Uttarakhand", city: "Nadipur", type: "Engineering", studentIntake: 240, facultyCount: 14, builtUpAreaSqm: 2800, landAreaAcres: 3.2, labCount: 8, fireNoc: "valid" },
  { code: "FIC-003", name: "Kaveri Bend School of Management", state: "Karnataka", city: "Example Nagar", type: "Management", studentIntake: 120, facultyCount: 8, builtUpAreaSqm: 1500, landAreaAcres: 2.5, labCount: 6, fireNoc: "valid" },
  { code: "FIC-004", name: "Aravali Heights Polytechnic", state: "Rajasthan", city: "Demogarh", type: "Diploma", studentIntake: 180, facultyCount: 10, builtUpAreaSqm: 2000, landAreaAcres: 3.0, labCount: 7, fireNoc: "valid" },
  { code: "FIC-005", name: "Brahmaputra Institute of Applied Sciences", state: "Assam", city: "Sampleshwar", type: "Engineering", studentIntake: 360, facultyCount: 20, builtUpAreaSqm: 4000, landAreaAcres: 5.5, labCount: 12, fireNoc: "valid" },
  { code: "FIC-006", name: "Godavari Coast College of Pharmacy", state: "Andhra Pradesh", city: "Mockpatnam", type: "Pharmacy", studentIntake: 100, facultyCount: 6, builtUpAreaSqm: 1200, landAreaAcres: 2.8, labCount: 6, fireNoc: "valid" },

  // ---- 4 institutions that fail specific rules (kept for the live demo) ----
  // Fails FACULTY_RATIO: 360 / 12 = 30 students per faculty.
  { code: "FIC-007", name: "Narmada Ridge Engineering College", state: "Gujarat", city: "Testwada", type: "Engineering", studentIntake: 360, facultyCount: 12, builtUpAreaSqm: 4000, landAreaAcres: 4.0, labCount: 9, fireNoc: "valid" },
  // Fails MIN_BUILTUP_AREA (1800 < 2400) and MIN_LABS (4 < 6).
  { code: "FIC-008", name: "Sahyadri Pines Institute of Technology", state: "Maharashtra", city: "Placeholderwadi", type: "Engineering", studentIntake: 240, facultyCount: 14, builtUpAreaSqm: 1800, landAreaAcres: 3.0, labCount: 4, fireNoc: "valid" },
  // Fails REQUIRED_DOCUMENTS: FIRE_NOC is missing.
  { code: "FIC-009", name: "Chambal Valley College of Architecture", state: "Madhya Pradesh", city: "Dummyganj", type: "Architecture", studentIntake: 120, facultyCount: 8, builtUpAreaSqm: 1500, landAreaAcres: 2.6, labCount: 6, fireNoc: "missing" },
  // Fails REQUIRED_DOCUMENTS (FIRE_NOC expired) and MIN_LAND_AREA (1.5 < 2.5).
  { code: "FIC-010", name: "Teesta Meadows Institute of Computing", state: "West Bengal", city: "Imaginagar", type: "Engineering", studentIntake: 180, facultyCount: 10, builtUpAreaSqm: 2000, landAreaAcres: 1.5, labCount: 7, fireNoc: "expired" },
];

async function seedInstitutions() {
  const created = [];
  for (const { fireNoc, ...data } of institutionData) {
    const docs: { docType: string; fileName: string; expiryDate: Date | null }[] = [
      { docType: "LAND_DEED", fileName: `${data.code}-land-deed.pdf`, expiryDate: null },
      { docType: "BUILDING_PLAN", fileName: `${data.code}-building-plan.pdf`, expiryDate: null },
    ];
    if (fireNoc === "valid") {
      docs.push({ docType: "FIRE_NOC", fileName: `${data.code}-fire-noc.pdf`, expiryDate: daysFromNow(365) });
    } else if (fireNoc === "expired") {
      docs.push({ docType: "FIRE_NOC", fileName: `${data.code}-fire-noc.pdf`, expiryDate: daysFromNow(-30) });
    }
    created.push(
      await prisma.institution.create({
        data: { ...data, documents: { create: docs } },
      })
    );
  }
  return created;
}

async function seedUsers(institutionIds: string[]) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const mk = (email: string, name: string, role: Role, extra: object = {}) =>
    prisma.user.create({ data: { email, name, role, passwordHash, ...extra } });

  const admin1 = await mk("admin1@niyamsetu.test", "Asha Admin (fictional)", Role.ADMIN);
  const admin2 = await mk("admin2@niyamsetu.test", "Bharat Admin (fictional)", Role.ADMIN);
  // Officers escalate to an admin.
  const officer1 = await mk("officer1@niyamsetu.test", "Chitra Officer (fictional)", Role.OFFICER, { managerId: admin1.id });
  const officer2 = await mk("officer2@niyamsetu.test", "Dev Officer (fictional)", Role.OFFICER, { managerId: admin2.id });
  // Institution users escalate to an officer.
  const inst1 = await mk("inst1@niyamsetu.test", "Esha Registrar (fictional)", Role.INSTITUTION, { institutionId: institutionIds[0], managerId: officer1.id });
  const inst2 = await mk("inst2@niyamsetu.test", "Farhan Registrar (fictional)", Role.INSTITUTION, { institutionId: institutionIds[1], managerId: officer2.id });
  // Not linked yet: the live demo registers a new college and links inst3 to it.
  const inst3 = await mk("inst3@niyamsetu.test", "Gauri Registrar (fictional)", Role.INSTITUTION, { managerId: officer1.id });

  return { admin1, admin2, officer1, officer2, inst1, inst2, inst3 };
}

// Stage path each sample application has walked through.
const PATHS: Record<ApplicationStage, ApplicationStage[]> = {
  SUBMITTED: ["SUBMITTED"],
  SCRUTINY: ["SUBMITTED", "SCRUTINY"],
  EXPERT_VISIT: ["SUBMITTED", "SCRUTINY", "EXPERT_VISIT"],
  COMMITTEE: ["SUBMITTED", "SCRUTINY", "EXPERT_VISIT", "COMMITTEE"],
  APPROVED: ["SUBMITTED", "SCRUTINY", "EXPERT_VISIT", "COMMITTEE", "APPROVED"],
  RETURNED: ["SUBMITTED", "SCRUTINY", "RETURNED"],
};

async function seedApplications(
  passingInstitutionIds: string[],
  officerIds: string[],
  adminId: string
) {
  const samples: { stage: ApplicationStage; programme: string }[] = [
    { stage: "SUBMITTED", programme: "B.Tech Computer Science" },
    { stage: "SCRUTINY", programme: "B.Tech Civil Engineering" },
    { stage: "EXPERT_VISIT", programme: "MBA" },
    { stage: "COMMITTEE", programme: "Diploma in Mechanical Engineering" },
    { stage: "APPROVED", programme: "B.Tech Electronics" },
    { stage: "RETURNED", programme: "B.Pharm" },
  ];

  for (let i = 0; i < samples.length; i++) {
    const { stage, programme } = samples[i];
    const officerId = officerIds[i % officerIds.length];
    const path = PATHS[stage];
    const submittedAt = daysFromNow(-3 * path.length - 2);

    const app = await prisma.application.create({
      data: {
        institutionId: passingInstitutionIds[i],
        programme,
        academicYear: "2027-28",
        stage,
        assignedOfficerId: officerId,
        submittedAt,
        ...(stage === "EXPERT_VISIT" && {
          expertVisitDate: daysFromNow(3),
          expertNames: "Dr. Kalpana Example (fictional), Prof. Rohan Sample (fictional)",
        }),
      },
    });

    // Stage history: one row per transition, spaced 3 days apart.
    for (let s = 0; s < path.length; s++) {
      await prisma.applicationStageHistory.create({
        data: {
          applicationId: app.id,
          fromStage: s === 0 ? null : path[s - 1],
          toStage: path[s],
          changedById: s === 0 ? adminId : officerId,
          remark: path[s] === "RETURNED" ? "Seed: returned for incomplete documentation" : null,
          changedAt: new Date(submittedAt.getTime() + s * 3 * DAY),
        },
      });
    }

    await prisma.auditLog.create({
      data: {
        actorId: adminId,
        action: "CREATE",
        entityType: "Application",
        entityId: app.id,
        after: { programme, stage, note: "created by seed script" },
      },
    });
  }
}

async function main() {
  await clearAll();
  await seedRules();
  const institutions = await seedInstitutions();
  const ids = institutions.map((i) => i.id);
  const users = await seedUsers(ids);
  // Only the 6 passing institutions get sample applications.
  await seedApplications(ids.slice(0, 6), [users.officer1.id, users.officer2.id], users.admin1.id);

  const counts = {
    users: await prisma.user.count(),
    institutions: await prisma.institution.count(),
    institutionDocuments: await prisma.institutionDocument.count(),
    complianceRules: await prisma.complianceRule.count(),
    applications: await prisma.application.count(),
    stageHistory: await prisma.applicationStageHistory.count(),
  };
  console.log("Seed complete:", counts);
  console.log(`All users share the demo password: ${DEMO_PASSWORD}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
