import type { ComplianceRule, Institution, InstitutionDocument, Prisma } from "@prisma/client";
import { prisma } from "../db";

export const RULE_CODES = [
  "FACULTY_RATIO",
  "MIN_BUILTUP_AREA",
  "MIN_LAND_AREA",
  "MIN_LABS",
  "REQUIRED_DOCUMENTS",
] as const;

// Shape of ComplianceRule.params. Each rule uses only its own fields.
type RuleParams = {
  maxStudentsPerFaculty?: number;
  minSqmPerStudent?: number;
  minAcres?: number;
  minLabs?: number;
  docTypes?: string[];
  evidenceNeeded?: string;
};

type InstitutionWithDocs = Institution & { documents: InstitutionDocument[] };
type Outcome = { passed: boolean; actual: string; expected: string; requirement: string };

// DEMO_MODE=true: deadlines in minutes instead of days.
export function defaultDueDate(): Date {
  const ms = process.env.DEMO_MODE === "true" ? 10 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms);
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const day = (d: Date) => d.toISOString().slice(0, 10);

// The version of a rule in force on a date. effectiveTo covers that whole day.
async function ruleInForce(code: string, asOf: Date): Promise<ComplianceRule | null> {
  const startOfDay = new Date(day(asOf));
  return prisma.complianceRule.findFirst({
    where: {
      code,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: startOfDay } }],
    },
    orderBy: { version: "desc" },
  });
}

// One check function per rule code.
function checkRule(rule: ComplianceRule, inst: InstitutionWithDocs, asOf: Date): Outcome {
  const p = rule.params as RuleParams;
  const label = `${rule.code} v${rule.version}`;

  switch (rule.code) {
    case "FACULTY_RATIO": {
      const max = p.maxStudentsPerFaculty!;
      const ratio = inst.facultyCount > 0 ? inst.studentIntake / inst.facultyCount : Infinity;
      return {
        passed: ratio <= max,
        actual: `${fmt(ratio)}:1`,
        expected: `max ${max}:1`,
        requirement: `Faculty ratio ${fmt(ratio)}:1 exceeds max ${max}:1 (${label})`,
      };
    }
    case "MIN_BUILTUP_AREA": {
      const min = p.minSqmPerStudent!;
      const perStudent = inst.builtUpAreaSqm / inst.studentIntake;
      return {
        passed: perStudent >= min,
        actual: `${fmt(perStudent)} sqm/student`,
        expected: `min ${min} sqm/student`,
        requirement: `Built-up area ${fmt(perStudent)} sqm per student is below min ${min} (${label})`,
      };
    }
    case "MIN_LAND_AREA": {
      const min = p.minAcres!;
      return {
        passed: inst.landAreaAcres >= min,
        actual: `${fmt(inst.landAreaAcres)} acres`,
        expected: `min ${min} acres`,
        requirement: `Land area ${fmt(inst.landAreaAcres)} acres is below min ${min} acres (${label})`,
      };
    }
    case "MIN_LABS": {
      const min = p.minLabs!;
      return {
        passed: inst.labCount >= min,
        actual: `${inst.labCount} labs`,
        expected: `min ${min} labs`,
        requirement: `${inst.labCount} labs is below min ${min} labs (${label})`,
      };
    }
    case "REQUIRED_DOCUMENTS": {
      const required = p.docTypes!;
      const problems: string[] = [];
      for (const docType of required) {
        const doc = inst.documents.find((d) => d.docType === docType);
        if (!doc) problems.push(`${docType} missing`);
        else if (doc.expiryDate && doc.expiryDate < asOf) problems.push(`${docType} expired ${day(doc.expiryDate)}`);
      }
      return {
        passed: problems.length === 0,
        actual: problems.length ? problems.join(", ") : "all present and valid",
        expected: `${required.join(", ")} present and valid`,
        requirement: `Required documents: ${problems.join(", ")} (${label})`,
      };
    }
    default:
      throw new Error(`No check function for rule code ${rule.code}`);
  }
}

// Runs every rule against an application's institution.
// With asOf (preview), RuleChecks are saved but no deficiencies are created.
export async function evaluate(applicationId: string, asOf?: Date) {
  const app = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    include: {
      institution: {
        include: {
          documents: true,
          users: { where: { role: "INSTITUTION" }, orderBy: { createdAt: "asc" } },
        },
      },
    },
  });
  const preview = asOf !== undefined;
  const checkDate = asOf ?? app.submittedAt;
  // Owner = oldest INSTITUTION user linked to this institution, or none yet.
  const ownerId = app.institution.users[0]?.id ?? null;

  const rules = await Promise.all(RULE_CODES.map((code) => ruleInForce(code, checkDate)));

  return prisma.$transaction(async (tx) => {
    const results = [];
    const deficienciesCreated = [];
    const deficienciesAlreadyOpen = [];

    for (let i = 0; i < RULE_CODES.length; i++) {
      const code = RULE_CODES[i];
      const rule = rules[i];
      if (!rule) {
        results.push({ code, version: null, passed: null, note: "No version in force on this date" });
        continue;
      }

      const outcome = checkRule(rule, app.institution, checkDate);
      const ruleCheck = await tx.ruleCheck.create({
        data: {
          applicationId,
          ruleId: rule.id,
          passed: outcome.passed,
          actualValue: outcome.actual,
          expectedValue: outcome.expected,
          isPreview: preview,
        },
      });
      results.push({
        code,
        version: rule.version,
        source: rule.source,
        passed: outcome.passed,
        actual: outcome.actual,
        expected: outcome.expected,
        ruleCheckId: ruleCheck.id,
      });

      if (outcome.passed || preview) continue;

      // Idempotent: any deficiency for this app + rule code that is not VERIFIED blocks a new one.
      const existing = await tx.deficiency.findFirst({
        where: { applicationId, status: { not: "VERIFIED" }, ruleCheck: { rule: { code } } },
      });
      if (existing) {
        deficienciesAlreadyOpen.push({ id: existing.id, code, status: existing.status });
        continue;
      }

      const data: Prisma.DeficiencyUncheckedCreateInput = {
        applicationId,
        ruleCheckId: ruleCheck.id,
        requirement: outcome.requirement,
        evidenceNeeded: (rule.params as RuleParams).evidenceNeeded ?? "Supporting evidence",
        ownerId,
        dueDate: defaultDueDate(),
        status: "OPEN",
      };
      deficienciesCreated.push(await tx.deficiency.create({ data }));
    }

    return {
      applicationId,
      asOf: checkDate,
      preview,
      ...(preview && { deficienciesSkipped: "asOf preview" }),
      results,
      deficienciesCreated,
      deficienciesAlreadyOpen,
      unassignedOwner: !preview && deficienciesCreated.length > 0 && ownerId === null,
    };
  });
}
