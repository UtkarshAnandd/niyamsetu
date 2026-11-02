# NiyamSetu API – contract for the frontend

Base URL: `http://localhost:4000/api` · Backend: `apps/api` (Express + TypeScript + Prisma)

Everything in this document comes from the route files in `apps/api/src/routes/` and from real
calls made against the dev API on port 4000 (with `DISABLE_CRON=true`). All data is **fictional**
and every rule threshold is a **placeholder**, not a real AICTE norm. IDs, times and counts in the
examples are whatever that run produced; long arrays are trimmed with an explicit
`"…": "N more items trimmed"` marker and JWTs are shortened – nothing else is edited.

- [Run locally](#run-locally)
- [Demo logins](#demo-logins)
- [Conventions](#conventions)
- [Auth](#auth)
- [Step 1 – Register a fictional institution](#step-1--register-a-fictional-institution)
- [Step 2 – Create an application](#step-2--create-an-application)
- [Steps 3–4 – Check against rules, generate deficiencies](#steps-34--check-against-rules-generate-deficiencies)
- [Step 5 – Assign owner and deadline](#step-5--assign-owner-and-deadline)
- [Step 6 – Alerts for pending/overdue tasks](#step-6--alerts-for-pendingoverdue-tasks)
- [Step 7 – Upload fictional evidence](#step-7--upload-fictional-evidence)
- [Step 8 – Officer verifies and updates status](#step-8--officer-verifies-and-updates-status)
- [Step 9 – Audit history and dashboard](#step-9--audit-history-and-dashboard)
- [Alerts](#alerts)
- [Dashboard](#dashboard)
- [Audit](#audit)
- [Health](#health)

---

## Run locally

```bash
# 1. PostgreSQL 16 in Docker (same settings as the team's niyamsetu-db container)
docker run -d --name niyamsetu-db \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=niyamsetu \
  -p 127.0.0.1:5432:5432 postgres:16-alpine

# 2. API
cd apps/api
cp .env.example .env      # DATABASE_URL, JWT_SECRET, PORT=4000, DEMO_MODE=true, DISABLE_CRON=false
npm i
npm run db:reset          # drops and recreates the niyamsetu tables, then seeds fictional data
npm run dev               # http://localhost:4000 (tsx watch)
```

`npm run db:seed` re-seeds without dropping tables (it also deletes all existing rows first).
`npm test` runs the end-to-end suite against a separate `niyamsetu_test` database.

## Demo logins

All seeded users share the password **`Demo@123`**. These three cover the whole demo:

| Email | Role | Notes |
| --- | --- | --- |
| `admin1@niyamsetu.test` | ADMIN | Registers institutions, links institution users, assigns officers, sees everything |
| `officer1@niyamsetu.test` | OFFICER | Manager: admin1. Can only change applications assigned to them |
| `inst3@niyamsetu.test` | INSTITUTION | Manager: officer1. **Not linked to any institution after a seed** – step 1 links it to the newly registered college; log in again after linking |

The seed also has `admin2`, `officer2` (manager admin2), `inst1` (linked to FIC-001) and `inst2` (linked to FIC-002).

## Conventions

**Authentication.** Every endpoint except `POST /auth/login` and `GET /health` needs
`Authorization: Bearer <token>`. The token is a JWT valid for **8 hours** carrying
`{ userId, role, institutionId }`. `institutionId` is fixed when the token is issued, so an
INSTITUTION user must log in again after `POST /users/link-institution`.

**Roles.** `ADMIN`, `OFFICER`, `INSTITUTION`. Besides the role check, visibility rules apply:

| Role | Applications (and their checks, deficiencies, evidence, audit) |
| --- | --- |
| ADMIN | all |
| OFFICER | only applications where `assignedOfficerId` is them; may **change** only those |
| INSTITUTION | only applications of their own institution (`institutionId` in the token) |

**Error shapes.**

| Status | When | Body |
| --- | --- | --- |
| 400 | zod validation failed | `{ "error": "Validation failed", "issues": [{ "path", "message" }] }` |
| 400 | malformed JSON body | `{ "error": "Malformed JSON body" }` |
| 400 | business rule (bad transition, wrong file type, …) | `{ "error": "…" }` (+ extra fields where noted) |
| 401 | missing/invalid/expired token, wrong password | `{ "error": "…" }` |
| 403 | wrong role or not your record | `{ "error": "…" }` |
| 404 | unknown id | `{ "error": "…" }` |
| 409 | unique field already exists (institution `code`) | `{ "error": "Already exists", "fields": ["code"] }` |
| 413 | JSON body larger than express's default limit | `{ "error": "request entity too large" }` |
| 500 | unexpected server error | `{ "error": "Internal server error" }` |

Real response as admin1 → **400**

```json
{
  "error": "Validation failed",
  "issues": [
    {
      "path": "code",
      "message": "Too small: expected string to have >=1 characters"
    },
    {
      "path": "name",
      "message": "Invalid input: expected string, received undefined"
    },
    {
      "…": "8 more items trimmed"
    }
  ]
}
```

Real response → **400**

```json
{
  "error": "Malformed JSON body"
}
```

Real response → **401**

```json
{
  "error": "Missing token"
}
```

Real response as officer1 → **403**

```json
{
  "error": "Forbidden for role OFFICER"
}
```

Real response as admin1 → **404**

```json
{
  "error": "Application not found"
}
```

**Dates** are ISO 8601 strings in UTC. Request date fields accept anything `new Date()` parses
(e.g. `"2026-11-05"` or `"2026-11-05T10:00:00Z"`).

**Pagination – `?limit`.** Today only these three endpoints take `?limit=` (integer, **default 50,
min 1, max 200**; outside that range → 400) and return a `total` count alongside the rows:

| Endpoint | Order |
| --- | --- |
| `GET /api/audit` | newest first |
| `GET /api/applications/:id/audit` | newest first |
| `GET /api/dashboard/overdue` | most overdue first |

Other list endpoints currently have no `limit` parameter: `GET /alerts` returns at most the
100 newest, `GET /alerts/history` at most the 500 newest, and the rest (`/institutions`,
`/applications`, `/deficiencies`) return every row the user may see. **The planned hardening pass
will add the same `?limit` rule (default 50, max 200) to every list endpoint.**

**DEMO_MODE.** With `DEMO_MODE=true` (the default in `.env.example`) all deadlines are counted in
**minutes instead of days**:

| | DEMO_MODE=true | DEMO_MODE=false |
| --- | --- | --- |
| Default due date for a new deficiency (and after a rejection) | now + 10 minutes | now + 7 days |
| "Due soon" window | 3 minutes | 2 days |
| Grace period before escalation | 2 minutes | 1 day |

`GET /dashboard/overdue` returns both `hoursOverdue` (1 decimal) and `minutesOverdue`. In
DEMO_MODE `hoursOverdue` stays at `0` for the first minutes, so **the UI should show
`minutesOverdue`** while `DEMO_MODE` is on.

**Deadline engine.** A node-cron job runs every minute (unless `DISABLE_CRON=true`).
`POST /admin/run-deadline-check` runs the same logic on demand (fallback button for the demo).

**Audit.** Every create, update and status change writes an AuditLog row (including logins and
system actions by the deadline engine, shown as actor "System"). Alert read receipts and GET
requests are not audited.

---

## Auth

### `POST /api/auth/login`

| | |
| --- | --- |
| Roles | public |
| Body | `email` string (valid email), `password` string (min 1) |
| Errors | 400 validation · 401 `Invalid email or password` |

Writes a `LOGIN` audit row. The `user` object never contains `passwordHash`.

Real response → **200**

```json
{
  "token": "eyJhbGciOi…",
  "user": {
    "id": "cmvy5x9b80019mvazika6aolz",
    "email": "admin1@niyamsetu.test",
    "name": "Asha Admin (fictional)",
    "role": "ADMIN",
    "managerId": null,
    "institutionId": null,
    "createdAt": "2026-11-01T18:27:42.308Z"
  }
}
```

### `GET /api/auth/me`

| | |
| --- | --- |
| Roles | any logged-in user |
| Errors | 401 (no/invalid token, or `User no longer exists`) |

Real response as officer1 → **200**

```json
{
  "user": {
    "id": "cmvy5x9be001cmvaz81z3xcw9",
    "email": "officer1@niyamsetu.test",
    "name": "Chitra Officer (fictional)",
    "role": "OFFICER",
    "institutionId": null,
    "managerId": "cmvy5x9b80019mvazika6aolz"
  }
}
```

---

## Step 1 – Register a fictional institution

### `POST /api/institutions`

| | |
| --- | --- |
| Roles | ADMIN |
| Body | `code` string (min 1, **unique**) · `name` string (min 1) · `state` string (min 1) · `city` string (min 1) · `type` string (min 1, e.g. "Engineering") · `studentIntake` integer > 0 · `facultyCount` integer ≥ 0 · `builtUpAreaSqm` integer ≥ 0 · `landAreaAcres` number ≥ 0 · `labCount` integer ≥ 0 · `documents` optional array of `{ docType` string (min 1, e.g. `LAND_DEED`, `BUILDING_PLAN`, `FIRE_NOC`) `, fileName` string (min 1) `, expiryDate` optional date `}` |
| Errors | 400 validation · 401 · 403 · 409 duplicate `code` |

`documents` is metadata only (no file upload); it feeds the `REQUIRED_DOCUMENTS` rule.

Real response as admin1 → **201**

```json
{
  "institution": {
    "id": "cmvywjrtz0004y6vy43mw7cey",
    "code": "FIC-012",
    "name": "Mahanadi Delta Institute of Technology",
    "state": "Odisha",
    "city": "Samplepur",
    "type": "Engineering",
    "studentIntake": 240,
    "facultyCount": 15,
    "builtUpAreaSqm": 2600,
    "landAreaAcres": 3,
    "labCount": 7,
    "createdAt": "2026-11-02T06:53:02.759Z",
    "documents": [
      {
        "id": "cmvywjrtz0005y6vy1fclmbwb",
        "institutionId": "cmvywjrtz0004y6vy43mw7cey",
        "docType": "LAND_DEED",
        "fileName": "FIC-012-land-deed.pdf",
        "expiryDate": null,
        "uploadedAt": "2026-11-02T06:53:02.759Z"
      },
      {
        "id": "cmvywjrtz0006y6vym0le9ltf",
        "institutionId": "cmvywjrtz0004y6vy43mw7cey",
        "docType": "BUILDING_PLAN",
        "fileName": "FIC-012-building-plan.pdf",
        "expiryDate": null,
        "uploadedAt": "2026-11-02T06:53:02.759Z"
      },
      {
        "…": "1 more items trimmed"
      }
    ]
  }
}
```

### `GET /api/institutions`

| | |
| --- | --- |
| Roles | ADMIN, OFFICER: all institutions · INSTITUTION: only its own (empty list if not linked) |
| Query | none |
| Errors | 401 |

Ordered by `code`, each with its `documents`.

Real response as inst3 → **200**

```json
{
  "institutions": [
    {
      "id": "cmvywjrtz0004y6vy43mw7cey",
      "code": "FIC-012",
      "name": "Mahanadi Delta Institute of Technology",
      "state": "Odisha",
      "city": "Samplepur",
      "type": "Engineering",
      "studentIntake": 240,
      "facultyCount": 15,
      "builtUpAreaSqm": 2600,
      "landAreaAcres": 3,
      "labCount": 7,
      "createdAt": "2026-11-02T06:53:02.759Z",
      "documents": [
        {
          "id": "cmvywjrtz0005y6vy1fclmbwb",
          "institutionId": "cmvywjrtz0004y6vy43mw7cey",
          "docType": "LAND_DEED",
          "fileName": "FIC-012-land-deed.pdf",
          "expiryDate": null,
          "uploadedAt": "2026-11-02T06:53:02.759Z"
        },
        {
          "id": "cmvywjrtz0006y6vym0le9ltf",
          "institutionId": "cmvywjrtz0004y6vy43mw7cey",
          "docType": "BUILDING_PLAN",
          "fileName": "FIC-012-building-plan.pdf",
          "expiryDate": null,
          "uploadedAt": "2026-11-02T06:53:02.759Z"
        },
        {
          "…": "1 more items trimmed"
        }
      ]
    }
  ]
}
```

### `POST /api/users/link-institution`

| | |
| --- | --- |
| Roles | ADMIN |
| Body | `email` string (valid email) · `institutionId` string (min 1) |
| Errors | 400 validation / `Only INSTITUTION users can be linked` · 401 · 403 · 404 `User not found` / `Institution not found` |

The user must **log in again** afterwards to get a token with the new `institutionId`.

Real response as admin1 → **200**

```json
{
  "user": {
    "id": "cmvy5x9bn001kmvazqr9ccixt",
    "email": "inst3@niyamsetu.test",
    "name": "Gauri Registrar (fictional)",
    "role": "INSTITUTION",
    "institutionId": "cmvywjrtz0004y6vy43mw7cey"
  }
}
```

---

## Step 2 – Create an application

### `POST /api/applications`

| | |
| --- | --- |
| Roles | INSTITUTION (for its own institution) · ADMIN |
| Body | `programme` string (min 1) · `academicYear` string (min 1, e.g. "2027-28") · `institutionId` string – **required for ADMIN, ignored for INSTITUTION** (taken from the token) |
| Errors | 400 validation / `Your account is not linked to an institution` / `institutionId is required` · 401 · 403 · 404 `Institution not found` |

Starts in stage `SUBMITTED`, unassigned, with a first stage-history row (`fromStage: null`).

Real response as inst3 → **201**

```json
{
  "application": {
    "id": "cmvywjry5000fy6vymfy0dzv3",
    "institutionId": "cmvywjrtz0004y6vy43mw7cey",
    "programme": "B.Tech Computer Science",
    "academicYear": "2027-28",
    "stage": "SUBMITTED",
    "assignedOfficerId": null,
    "expertVisitDate": null,
    "expertNames": null,
    "submittedAt": "2026-11-02T06:53:02.910Z",
    "updatedAt": "2026-11-02T06:53:02.910Z"
  }
}
```

### `GET /api/applications`

| | |
| --- | --- |
| Roles | any; ADMIN all, OFFICER assigned to them, INSTITUTION own institution |
| Query | none |
| Errors | 401 |

Newest `submittedAt` first; includes `institution { id, code, name }` and `assignedOfficer { id, name, email }`.

Real response as officer1 → **200**

```json
{
  "applications": [
    {
      "id": "cmvywjry5000fy6vymfy0dzv3",
      "institutionId": "cmvywjrtz0004y6vy43mw7cey",
      "programme": "B.Tech Computer Science",
      "academicYear": "2027-28",
      "stage": "SUBMITTED",
      "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
      "expertVisitDate": null,
      "expertNames": null,
      "submittedAt": "2026-11-02T06:53:02.910Z",
      "updatedAt": "2026-11-02T06:53:02.925Z",
      "institution": {
        "id": "cmvywjrtz0004y6vy43mw7cey",
        "code": "FIC-012",
        "name": "Mahanadi Delta Institute of Technology"
      },
      "assignedOfficer": {
        "id": "cmvy5x9be001cmvaz81z3xcw9",
        "name": "Chitra Officer (fictional)",
        "email": "officer1@niyamsetu.test"
      }
    },
    {
      "id": "cmvy5xapj001xmvb3ffubidtw",
      "institutionId": "cmvy5xak2001mmvb3gp2w1oso",
      "programme": "B.Tech Computer Science",
      "academicYear": "2027-28",
      "stage": "SCRUTINY",
      "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
      "expertVisitDate": null,
      "expertNames": null,
      "submittedAt": "2026-11-01T18:27:44.120Z",
      "updatedAt": "2026-11-01T18:27:44.239Z",
      "institution": {
        "id": "cmvy5xak2001mmvb3gp2w1oso",
        "code": "FIC-011",
        "name": "Kosi Plains Institute of Engineering"
      },
      "assignedOfficer": {
        "id": "cmvy5x9be001cmvaz81z3xcw9",
        "name": "Chitra Officer (fictional)",
        "email": "officer1@niyamsetu.test"
      }
    },
    {
      "…": "4 more items trimmed"
    }
  ]
}
```

### `GET /api/applications/:id`

| | |
| --- | --- |
| Roles | any, subject to the visibility rules |
| Errors | 401 · 403 `You cannot view this application` · 404 `Application not found` |

Includes the full `institution` (with measured fields), `assignedOfficer` and `stageHistory`
(oldest first, each with `changedBy { id, name, role }`). Example taken after the full flow:

Real response as inst3 → **200**

```json
{
  "application": {
    "id": "cmvywjry5000fy6vymfy0dzv3",
    "institutionId": "cmvywjrtz0004y6vy43mw7cey",
    "programme": "B.Tech Computer Science",
    "academicYear": "2027-28",
    "stage": "APPROVED",
    "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
    "expertVisitDate": "2026-11-05T06:56:06.510Z",
    "expertNames": "Dr. Kalpana Example (fictional)",
    "submittedAt": "2026-11-02T06:53:02.910Z",
    "updatedAt": "2026-11-02T06:56:06.625Z",
    "institution": {
      "id": "cmvywjrtz0004y6vy43mw7cey",
      "code": "FIC-012",
      "name": "Mahanadi Delta Institute of Technology",
      "state": "Odisha",
      "city": "Samplepur",
      "type": "Engineering",
      "studentIntake": 240,
      "facultyCount": 15,
      "builtUpAreaSqm": 2600,
      "landAreaAcres": 3,
      "labCount": 7,
      "createdAt": "2026-11-02T06:53:02.759Z"
    },
    "assignedOfficer": {
      "id": "cmvy5x9be001cmvaz81z3xcw9",
      "name": "Chitra Officer (fictional)",
      "email": "officer1@niyamsetu.test"
    },
    "stageHistory": [
      {
        "id": "cmvywjry5000hy6vy633apbi5",
        "applicationId": "cmvywjry5000fy6vymfy0dzv3",
        "fromStage": null,
        "toStage": "SUBMITTED",
        "changedById": "cmvy5x9bn001kmvazqr9ccixt",
        "remark": null,
        "changedAt": "2026-11-02T06:53:02.910Z",
        "changedBy": {
          "id": "cmvy5x9bn001kmvazqr9ccixt",
          "name": "Gauri Registrar (fictional)",
          "role": "INSTITUTION"
        }
      },
      {
        "id": "cmvywnplx0037y6vytr2qw4o1",
        "applicationId": "cmvywjry5000fy6vymfy0dzv3",
        "fromStage": "SUBMITTED",
        "toStage": "SCRUTINY",
        "changedById": "cmvy5x9be001cmvaz81z3xcw9",
        "remark": "Documents received",
        "changedAt": "2026-11-02T06:56:06.501Z",
        "changedBy": {
          "id": "cmvy5x9be001cmvaz81z3xcw9",
          "name": "Chitra Officer (fictional)",
          "role": "OFFICER"
        }
      },
      {
        "…": "3 more items trimmed"
      }
    ]
  }
}
```

### `POST /api/applications/:id/assign`

| | |
| --- | --- |
| Roles | ADMIN |
| Body | `officerId` string (min 1) – must be an OFFICER user |
| Errors | 400 validation / `officerId must belong to an OFFICER user` · 401 · 403 · 404 `Application not found` |

Real response as admin1 → **200**

```json
{
  "application": {
    "id": "cmvywjry5000fy6vymfy0dzv3",
    "institutionId": "cmvywjrtz0004y6vy43mw7cey",
    "programme": "B.Tech Computer Science",
    "academicYear": "2027-28",
    "stage": "SUBMITTED",
    "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
    "expertVisitDate": null,
    "expertNames": null,
    "submittedAt": "2026-11-02T06:53:02.910Z",
    "updatedAt": "2026-11-02T06:53:02.925Z"
  }
}
```

### `PATCH /api/applications/:id/stage`

| | |
| --- | --- |
| Roles | OFFICER (only if assigned) · ADMIN |
| Body | `toStage` one of `SUBMITTED` `SCRUTINY` `EXPERT_VISIT` `COMMITTEE` `APPROVED` `RETURNED` · `remark` optional string |
| Errors | 400 validation / invalid transition (`{ error, allowed }`) / approval blocked (`{ error, pendingDeficiencies }`) · 401 · 403 `Application is not assigned to you` · 404 |

Allowed transitions:

| From | To |
| --- | --- |
| SUBMITTED | SCRUTINY |
| SCRUTINY | EXPERT_VISIT, RETURNED |
| EXPERT_VISIT | COMMITTEE, RETURNED |
| COMMITTEE | APPROVED, RETURNED |
| RETURNED | SUBMITTED (resubmission) |
| APPROVED | – (final) |

Moving to `APPROVED` is refused while the application has any deficiency that is not `VERIFIED`.
Each change writes a stage-history row and a `STATUS_CHANGE` audit row.

Real response as officer1 → **200**

```json
{
  "application": {
    "id": "cmvywjry5000fy6vymfy0dzv3",
    "institutionId": "cmvywjrtz0004y6vy43mw7cey",
    "programme": "B.Tech Computer Science",
    "academicYear": "2027-28",
    "stage": "SCRUTINY",
    "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
    "expertVisitDate": null,
    "expertNames": null,
    "submittedAt": "2026-11-02T06:53:02.910Z",
    "updatedAt": "2026-11-02T06:56:06.501Z"
  }
}
```

Real response as officer1 → **400**

```json
{
  "error": "Cannot move from COMMITTEE to SUBMITTED",
  "allowed": [
    "APPROVED",
    "RETURNED"
  ]
}
```

Real response as officer1 → **400**

```json
{
  "error": "Cannot approve: some deficiencies are not verified",
  "pendingDeficiencies": [
    {
      "id": "cmvywjs09000xy6vyh1punjvj",
      "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
      "status": "EVIDENCE_SUBMITTED",
      "dueDate": "2026-11-02T06:54:03.037Z"
    }
  ]
}
```

### `PATCH /api/applications/:id/expert-visit`

| | |
| --- | --- |
| Roles | OFFICER (only if assigned) · ADMIN |
| Body | `expertVisitDate` date · `expertNames` string (min 1) |
| Errors | 400 validation / `Expert visit can only be set in SCRUTINY or EXPERT_VISIT` · 401 · 403 · 404 |

Real response as officer1 → **200**

```json
{
  "application": {
    "id": "cmvywjry5000fy6vymfy0dzv3",
    "institutionId": "cmvywjrtz0004y6vy43mw7cey",
    "programme": "B.Tech Computer Science",
    "academicYear": "2027-28",
    "stage": "SCRUTINY",
    "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
    "expertVisitDate": "2026-11-05T06:56:06.510Z",
    "expertNames": "Dr. Kalpana Example (fictional)",
    "submittedAt": "2026-11-02T06:53:02.910Z",
    "updatedAt": "2026-11-02T06:56:06.514Z"
  }
}
```

---

## Steps 3–4 – Check against rules, generate deficiencies

### `POST /api/applications/:id/check`

| | |
| --- | --- |
| Roles | INSTITUTION (own application, as a pre-check) · OFFICER (assigned) · ADMIN |
| Body | optional; `asOf` date – **ADMIN only** |
| Errors | 400 validation · 401 · 403 `You cannot check this application` / `Only ADMIN can check as of another date` · 404 |

Evaluates the 5 rule codes (`FACULTY_RATIO`, `MIN_BUILTUP_AREA`, `MIN_LAND_AREA`, `MIN_LABS`,
`REQUIRED_DOCUMENTS`), each with the **version in force on the application's `submittedAt`**
(or on `asOf`). Saves one RuleCheck per rule and creates one `OPEN` deficiency per failed rule –
unless that application already has a non-`VERIFIED` deficiency for the same rule code (listed in
`deficienciesAlreadyOpen`). Owner = the institution's oldest linked INSTITUTION user (or `null`;
then `unassignedOwner: true`). Due date = default (see DEMO_MODE).

Real response as inst3 → **200**

```json
{
  "applicationId": "cmvywjry5000fy6vymfy0dzv3",
  "asOf": "2026-11-02T06:53:02.910Z",
  "preview": false,
  "results": [
    {
      "code": "FACULTY_RATIO",
      "version": 2,
      "source": "placeholder – not a real AICTE norm",
      "passed": true,
      "actual": "16:1",
      "expected": "max 20:1",
      "ruleCheckId": "cmvywjs00000ny6vyzci1g12b"
    },
    {
      "code": "MIN_BUILTUP_AREA",
      "version": 1,
      "source": "placeholder – not a real AICTE norm",
      "passed": true,
      "actual": "10.8 sqm/student",
      "expected": "min 10 sqm/student",
      "ruleCheckId": "cmvywjs03000py6vy43b1kogc"
    },
    {
      "…": "3 more items trimmed"
    }
  ],
  "deficienciesCreated": [
    {
      "id": "cmvywjs09000xy6vyh1punjvj",
      "applicationId": "cmvywjry5000fy6vymfy0dzv3",
      "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
      "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
      "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
      "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
      "dueDate": "2026-11-02T07:03:02.985Z",
      "status": "OPEN",
      "escalatedAt": null,
      "createdAt": "2026-11-02T06:53:02.986Z",
      "updatedAt": "2026-11-02T06:53:02.986Z"
    }
  ],
  "deficienciesAlreadyOpen": [],
  "unassignedOwner": false
}
```

With `asOf` the run is a **preview**: RuleChecks are saved with `isPreview: true`, no deficiencies
are created, and `GET /checks` ignores it. Versioning example (FACULTY_RATIO v1, max 15:1, was in
force until 2026-06-30):

Real response as admin1 → **200**

```json
{
  "applicationId": "cmvywjry5000fy6vymfy0dzv3",
  "asOf": "2026-06-01T00:00:00.000Z",
  "preview": true,
  "deficienciesSkipped": "asOf preview",
  "results": [
    {
      "code": "FACULTY_RATIO",
      "version": 1,
      "source": "placeholder – not a real AICTE norm",
      "passed": false,
      "actual": "16:1",
      "expected": "max 15:1",
      "ruleCheckId": "cmvywjs0r0013y6vy0ghx0y5k"
    },
    {
      "code": "MIN_BUILTUP_AREA",
      "version": 1,
      "source": "placeholder – not a real AICTE norm",
      "passed": true,
      "actual": "10.8 sqm/student",
      "expected": "min 10 sqm/student",
      "ruleCheckId": "cmvywjs0t0015y6vygse3wdjx"
    },
    {
      "…": "3 more items trimmed"
    }
  ],
  "deficienciesCreated": [],
  "deficienciesAlreadyOpen": [],
  "unassignedOwner": false
}
```

### `GET /api/applications/:id/checks`

| | |
| --- | --- |
| Roles | any, subject to the visibility rules |
| Errors | 401 · 403 · 404 |

Latest non-preview result for each rule code.

Real response as inst3 → **200**

```json
{
  "applicationId": "cmvywjry5000fy6vymfy0dzv3",
  "checks": [
    {
      "code": "MIN_LABS",
      "version": 1,
      "source": "placeholder – not a real AICTE norm",
      "passed": true,
      "actual": "7 labs",
      "expected": "min 6 labs",
      "checkedAt": "2026-11-02T06:53:02.981Z"
    },
    {
      "code": "REQUIRED_DOCUMENTS",
      "version": 1,
      "source": "placeholder – not a real AICTE norm",
      "passed": false,
      "actual": "FIRE_NOC expired 2026-10-03",
      "expected": "LAND_DEED, BUILDING_PLAN, FIRE_NOC present and valid",
      "checkedAt": "2026-11-02T06:53:02.981Z"
    },
    {
      "…": "3 more items trimmed"
    }
  ]
}
```

---

## Step 5 – Assign owner and deadline

### `GET /api/deficiencies`

| | |
| --- | --- |
| Roles | any; ADMIN all, OFFICER on applications assigned to them, INSTITUTION own institution |
| Query | `applicationId` optional string · `status` optional, one of `OPEN` `EVIDENCE_SUBMITTED` `VERIFIED` `REJECTED` `OVERDUE` |
| Errors | 400 validation · 401 |

Ordered by `dueDate`, then `createdAt`; includes `owner`, `application { id, programme, institution { code, name } }` and `ruleCheck.rule { code, version }`.

Real response as inst3 → **200**

```json
{
  "deficiencies": [
    {
      "id": "cmvywjs09000xy6vyh1punjvj",
      "applicationId": "cmvywjry5000fy6vymfy0dzv3",
      "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
      "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
      "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
      "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
      "dueDate": "2026-11-02T07:03:02.985Z",
      "status": "OPEN",
      "escalatedAt": null,
      "createdAt": "2026-11-02T06:53:02.986Z",
      "updatedAt": "2026-11-02T06:53:02.986Z",
      "owner": {
        "id": "cmvy5x9bn001kmvazqr9ccixt",
        "name": "Gauri Registrar (fictional)",
        "email": "inst3@niyamsetu.test",
        "role": "INSTITUTION"
      },
      "application": {
        "id": "cmvywjry5000fy6vymfy0dzv3",
        "programme": "B.Tech Computer Science",
        "institution": {
          "code": "FIC-012",
          "name": "Mahanadi Delta Institute of Technology"
        }
      },
      "ruleCheck": {
        "rule": {
          "code": "REQUIRED_DOCUMENTS",
          "version": 1
        }
      }
    }
  ]
}
```

### `GET /api/deficiencies/:id`

| | |
| --- | --- |
| Roles | any, subject to the visibility rules |
| Errors | 401 · 403 `You cannot view this deficiency` · 404 `Deficiency not found` |

Includes `ruleCheck.rule`, `application` (with `institution` and `assignedOfficer`), `owner` and
`evidence` (newest first, with `uploadedBy`, `verifiedBy` and **`reviewRemark` – show it to the
institution, it is the reason for a rejection**). Example taken after a rejection:

Real response as inst3 → **200**

```json
{
  "deficiency": {
    "id": "cmvywjs09000xy6vyh1punjvj",
    "applicationId": "cmvywjry5000fy6vymfy0dzv3",
    "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
    "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
    "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
    "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
    "dueDate": "2026-11-02T07:06:06.556Z",
    "status": "REJECTED",
    "escalatedAt": null,
    "createdAt": "2026-11-02T06:53:02.986Z",
    "updatedAt": "2026-11-02T06:56:06.557Z",
    "ruleCheck": {
      "id": "cmvywjs05000vy6vyi0pi0kdg",
      "applicationId": "cmvywjry5000fy6vymfy0dzv3",
      "ruleId": "cmvy5x9740005mvazctigonwq",
      "passed": false,
      "actualValue": "FIRE_NOC expired 2026-10-03",
      "expectedValue": "LAND_DEED, BUILDING_PLAN, FIRE_NOC present and valid",
      "isPreview": false,
      "checkedAt": "2026-11-02T06:53:02.981Z",
      "rule": {
        "id": "cmvy5x9740005mvazctigonwq",
        "code": "REQUIRED_DOCUMENTS",
        "version": 1,
        "title": "Mandatory documents present and not expired",
        "source": "placeholder – not a real AICTE norm",
        "effectiveFrom": "2024-07-01T00:00:00.000Z",
        "effectiveTo": null,
        "params": {
          "docTypes": [
            "LAND_DEED",
            "BUILDING_PLAN",
            {
              "…": "1 more items trimmed"
            }
          ],
          "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date"
        },
        "createdAt": "2026-11-01T18:27:42.160Z"
      }
    },
    "application": {
      "id": "cmvywjry5000fy6vymfy0dzv3",
      "institutionId": "cmvywjrtz0004y6vy43mw7cey",
      "programme": "B.Tech Computer Science",
      "academicYear": "2027-28",
      "stage": "COMMITTEE",
      "assignedOfficerId": "cmvy5x9be001cmvaz81z3xcw9",
      "expertVisitDate": "2026-11-05T06:56:06.510Z",
      "expertNames": "Dr. Kalpana Example (fictional)",
      "submittedAt": "2026-11-02T06:53:02.910Z",
      "updatedAt": "2026-11-02T06:56:06.534Z",
      "institution": {
        "id": "cmvywjrtz0004y6vy43mw7cey",
        "code": "FIC-012",
        "name": "Mahanadi Delta Institute of Technology"
      },
      "assignedOfficer": {
        "id": "cmvy5x9be001cmvaz81z3xcw9",
        "name": "Chitra Officer (fictional)",
        "email": "officer1@niyamsetu.test"
      }
    },
    "owner": {
      "id": "cmvy5x9bn001kmvazqr9ccixt",
      "name": "Gauri Registrar (fictional)",
      "email": "inst3@niyamsetu.test",
      "role": "INSTITUTION"
    },
    "evidence": [
      {
        "id": "cmvywnpl0002xy6vyagv27po7",
        "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
        "uploadedById": "cmvy5x9bn001kmvazqr9ccixt",
        "fileName": "fire-noc-receipt.pdf",
        "filePath": "1793602566459-450dbcf4-fire-noc-receipt.pdf",
        "mimeType": "application/pdf",
        "note": "Renewal receipt (fictional)",
        "verifiedById": null,
        "verifiedAt": null,
        "reviewRemark": "Receipt only – upload the issued Fire NOC",
        "uploadedAt": "2026-11-02T06:56:06.467Z",
        "uploadedBy": {
          "id": "cmvy5x9bn001kmvazqr9ccixt",
          "name": "Gauri Registrar (fictional)"
        },
        "verifiedBy": null
      }
    ]
  }
}
```

### `PATCH /api/deficiencies/:id/assign`

| | |
| --- | --- |
| Roles | OFFICER (only if assigned to the application) · ADMIN |
| Body | `ownerId` optional string · `dueDate` optional date – **at least one is required** |
| Errors | 400 validation / `dueDate must be in the future` / `Owner must be an INSTITUTION user of this institution or the assigned OFFICER` · 401 · 403 · 404 |

The owner must be an INSTITUTION user linked to that application's institution, or the
application's assigned OFFICER. Setting a new `dueDate` on an `OVERDUE` deficiency **reopens** it
(`status: OPEN`, `escalatedAt: null`) so the deadline engine can alert again.

Real response as officer1 → **200**

```json
{
  "deficiency": {
    "id": "cmvywjs09000xy6vyh1punjvj",
    "applicationId": "cmvywjry5000fy6vymfy0dzv3",
    "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
    "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
    "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
    "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
    "dueDate": "2026-11-02T06:54:03.037Z",
    "status": "OPEN",
    "escalatedAt": null,
    "createdAt": "2026-11-02T06:53:02.986Z",
    "updatedAt": "2026-11-02T06:53:03.042Z"
  }
}
```

---

## Step 6 – Alerts for pending/overdue tasks

### `POST /api/admin/run-deadline-check`

| | |
| --- | --- |
| Roles | ADMIN |
| Body | none |
| Errors | 401 · 403 |

Runs the same check as the cron job, immediately:

| Pass | Condition | Effect | Alert to |
| --- | --- | --- | --- |
| DUE_SOON | `OPEN`/`REJECTED`, due within the window | – | owner → else assigned officer → else all admins |
| OVERDUE | `OPEN`/`REJECTED`, due date passed | status → `OVERDUE` | owner → else assigned officer → else all admins |
| ESCALATION | `OVERDUE`, not yet escalated, past due + grace | `escalatedAt` set | owner's manager → else assigned officer's manager → else all admins |
| EVC | application in `EXPERT_VISIT`, `expertVisitDate` within the window | – | assigned officer → else all admins |

Every alert has a unique `dedupKey` that includes the due date (e.g.
`ESCALATION:<deficiencyId>:<dueDate ms>`), so repeated runs never send the same alert twice, but a
new due date can alert and escalate again. The counts only include alerts that were new in this
run. Example from the run after the grace period (the same deficiency had gone `OVERDUE` in the
previous run):

Real response as admin1 → **200**

```json
{
  "ranAt": "2026-11-02T06:56:06.386Z",
  "dueSoon": 0,
  "overdue": 0,
  "escalated": 1,
  "evcReminders": 0,
  "details": [
    {
      "kind": "ESCALATION",
      "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
      "alertedUserIds": [
        "cmvy5x9be001cmvaz81z3xcw9"
      ]
    }
  ]
}
```

Alerts are read through the [Alerts](#alerts) endpoints. Overdue items are listed by
[`GET /dashboard/overdue`](#get-apidashboardoverdue).

---

## Step 7 – Upload fictional evidence

### `POST /api/deficiencies/:id/evidence`

| | |
| --- | --- |
| Roles | the deficiency's owner, or an INSTITUTION user of that institution |
| Body | `multipart/form-data`: `file` (required; `.pdf` `application/pdf`, `.png` `image/png`, `.jpg`/`.jpeg` `image/jpeg`; **max 5 MB**) · `note` optional text |
| Errors | 400 `File is required (form field name: file)` / `Only PDF, PNG or JPG files are allowed` / `File too large (max 5 MB)` / `Deficiency is already verified` · 401 · 403 `You cannot upload evidence for this deficiency` · 404 |

Permission is checked before the file is stored. Sets the deficiency to `EVIDENCE_SUBMITTED` and
alerts the assigned officer – or every ADMIN if none is assigned (`alertedRole`).

Real response as inst3 → **201**

```json
{
  "evidence": {
    "id": "cmvywnpl0002xy6vyagv27po7",
    "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
    "uploadedById": "cmvy5x9bn001kmvazqr9ccixt",
    "fileName": "fire-noc-receipt.pdf",
    "filePath": "1793602566459-450dbcf4-fire-noc-receipt.pdf",
    "mimeType": "application/pdf",
    "note": "Renewal receipt (fictional)",
    "verifiedById": null,
    "verifiedAt": null,
    "reviewRemark": null,
    "uploadedAt": "2026-11-02T06:56:06.467Z"
  },
  "deficiency": {
    "id": "cmvywjs09000xy6vyh1punjvj",
    "applicationId": "cmvywjry5000fy6vymfy0dzv3",
    "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
    "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
    "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
    "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
    "dueDate": "2026-11-02T06:54:03.037Z",
    "status": "EVIDENCE_SUBMITTED",
    "escalatedAt": "2026-11-02T06:56:06.386Z",
    "createdAt": "2026-11-02T06:53:02.986Z",
    "updatedAt": "2026-11-02T06:56:06.467Z"
  },
  "alertedRole": "OFFICER"
}
```

### `GET /api/evidence/:id/file`

| | |
| --- | --- |
| Roles | any, subject to the visibility rules of the deficiency's application |
| Errors | 401 · 403 `You cannot view this evidence` · 404 `Evidence not found` |

Streams the file with its stored content type (`Content-Disposition: inline`). Use it with the
bearer token (e.g. fetch → blob → object URL); a plain `<a href>` will not send the header.

Real response as officer1 → **200**

```http
content-type: application/pdf
content-disposition: inline; filename="fire-noc-receipt.pdf"
content-length: 180

<180 bytes of file content>
```

---

## Step 8 – Officer verifies and updates status

### `PATCH /api/deficiencies/:id/verify`

| | |
| --- | --- |
| Roles | OFFICER (only if assigned) · ADMIN |
| Body | `decision` `"VERIFIED"` or `"REJECTED"` · `remark` optional string – **required when rejecting** |
| Errors | 400 validation / `Can only verify when evidence is submitted (status is …)` · 401 · 403 · 404 |

Acts on the newest evidence. `VERIFIED` sets `verifiedById`/`verifiedAt` on it; `REJECTED` gives
the deficiency a new default due date and resets `escalatedAt`. The remark is stored in
`evidence.reviewRemark`. The owner is alerted either way (`ownerAlerted`).

Real response as officer1 → **200**

```json
{
  "deficiency": {
    "id": "cmvywjs09000xy6vyh1punjvj",
    "applicationId": "cmvywjry5000fy6vymfy0dzv3",
    "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
    "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
    "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
    "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
    "dueDate": "2026-11-02T07:06:06.556Z",
    "status": "REJECTED",
    "escalatedAt": null,
    "createdAt": "2026-11-02T06:53:02.986Z",
    "updatedAt": "2026-11-02T06:56:06.557Z"
  },
  "evidence": {
    "id": "cmvywnpl0002xy6vyagv27po7",
    "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
    "uploadedById": "cmvy5x9bn001kmvazqr9ccixt",
    "fileName": "fire-noc-receipt.pdf",
    "filePath": "1793602566459-450dbcf4-fire-noc-receipt.pdf",
    "mimeType": "application/pdf",
    "note": "Renewal receipt (fictional)",
    "verifiedById": null,
    "verifiedAt": null,
    "reviewRemark": "Receipt only – upload the issued Fire NOC",
    "uploadedAt": "2026-11-02T06:56:06.467Z"
  },
  "ownerAlerted": true
}
```

Real response as officer1 → **200**

```json
{
  "deficiency": {
    "id": "cmvywjs09000xy6vyh1punjvj",
    "applicationId": "cmvywjry5000fy6vymfy0dzv3",
    "ruleCheckId": "cmvywjs05000vy6vyi0pi0kdg",
    "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
    "evidenceNeeded": "Upload the missing or renewed document with a valid expiry date",
    "ownerId": "cmvy5x9bn001kmvazqr9ccixt",
    "dueDate": "2026-11-02T07:06:06.556Z",
    "status": "VERIFIED",
    "escalatedAt": null,
    "createdAt": "2026-11-02T06:53:02.986Z",
    "updatedAt": "2026-11-02T06:56:06.609Z"
  },
  "evidence": {
    "id": "cmvywnpoe003ty6vyqo5t4rog",
    "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
    "uploadedById": "cmvy5x9bn001kmvazqr9ccixt",
    "fileName": "fire-noc-renewed.png",
    "filePath": "1793602566588-1ea736e3-fire-noc-renewed.png",
    "mimeType": "image/png",
    "note": null,
    "verifiedById": "cmvy5x9be001cmvaz81z3xcw9",
    "verifiedAt": "2026-11-02T06:56:06.608Z",
    "reviewRemark": "Renewed NOC checked",
    "uploadedAt": "2026-11-02T06:56:06.590Z"
  },
  "ownerAlerted": true
}
```

After all deficiencies are `VERIFIED`, the officer moves the application on with
[`PATCH /applications/:id/stage`](#patch-apiapplicationsidstage) (`COMMITTEE` → `APPROVED`).

---

## Step 9 – Audit history and dashboard

See [Dashboard](#dashboard) for the summary numbers and charts and [Audit](#audit) for the
history views.

---

## Alerts

All alert endpoints work on **the current user's own alerts** (except the ADMIN view of
`/history`). Types: `DUE_SOON`, `OVERDUE`, `ESCALATION`, `STATUS_CHANGE`.

### `GET /api/alerts`

| | |
| --- | --- |
| Roles | any |
| Query | `unread` optional, `"true"` or `"false"` (`"true"` → unread only) |
| Errors | 400 validation · 401 |

Newest first, at most 100, plus `unreadCount`; each alert includes a `deficiency` summary or `null`.

Real response as inst3 → **200**

```json
{
  "unreadCount": 5,
  "alerts": [
    {
      "id": "cmvywnpp50047y6vy1lfv1jgo",
      "userId": "cmvy5x9bn001kmvazqr9ccixt",
      "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
      "type": "STATUS_CHANGE",
      "message": "Evidence verified for FIC-012: Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1) – Renewed NOC checked",
      "dedupKey": "VERIFIED:cmvywnpoe003ty6vyqo5t4rog",
      "isRead": false,
      "createdAt": "2026-11-02T06:56:06.617Z",
      "deficiency": {
        "id": "cmvywjs09000xy6vyh1punjvj",
        "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
        "status": "VERIFIED",
        "applicationId": "cmvywjry5000fy6vymfy0dzv3"
      }
    },
    {
      "id": "cmvywnpnq003py6vy842ei4v5",
      "userId": "cmvy5x9bn001kmvazqr9ccixt",
      "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
      "type": "STATUS_CHANGE",
      "message": "Evidence rejected for FIC-012: Receipt only – upload the issued Fire NOC. Re-upload by 2026-11-02T07:06:06.556Z",
      "dedupKey": "REJECTED:cmvywnpl0002xy6vyagv27po7",
      "isRead": false,
      "createdAt": "2026-11-02T06:56:06.566Z",
      "deficiency": {
        "id": "cmvywjs09000xy6vyh1punjvj",
        "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
        "status": "VERIFIED",
        "applicationId": "cmvywjry5000fy6vymfy0dzv3"
      }
    },
    {
      "…": "3 more items trimmed"
    }
  ]
}
```

### `PATCH /api/alerts/:id/read`

| | |
| --- | --- |
| Roles | any – own alerts only |
| Errors | 401 · 403 `Not your alert` · 404 `Alert not found` |

Real response as inst3 → **200**

```json
{
  "alert": {
    "id": "cmvywnpp50047y6vy1lfv1jgo",
    "userId": "cmvy5x9bn001kmvazqr9ccixt",
    "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
    "type": "STATUS_CHANGE",
    "message": "Evidence verified for FIC-012: Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1) – Renewed NOC checked",
    "dedupKey": "VERIFIED:cmvywnpoe003ty6vyqo5t4rog",
    "isRead": true,
    "createdAt": "2026-11-02T06:56:06.617Z"
  }
}
```

### `PATCH /api/alerts/read-all`

| | |
| --- | --- |
| Roles | any |
| Errors | 401 |

Real response as inst3 → **200**

```json
{
  "updated": 4
}
```

### `GET /api/alerts/history`

| | |
| --- | --- |
| Roles | ADMIN: every alert · others: own alerts only (`userId` is ignored) |
| Query | `type` optional (`DUE_SOON` `OVERDUE` `ESCALATION` `STATUS_CHANGE`) · `userId` optional string (ADMIN only) |
| Errors | 400 validation · 401 |

Newest first, at most 500, each with `user { id, name, email, role }` and a `deficiency` summary.

Real response as admin1 → **200**

```json
{
  "alerts": [
    {
      "id": "cmvywnpjg002ty6vyiwklyw1p",
      "userId": "cmvy5x9be001cmvaz81z3xcw9",
      "deficiencyId": "cmvywjs09000xy6vyh1punjvj",
      "type": "ESCALATION",
      "message": "Escalation: FIC-012 deficiency overdue since 2026-11-02T06:54:03.037Z, owner Gauri Registrar (fictional) – Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
      "dedupKey": "ESCALATION:cmvywjs09000xy6vyh1punjvj:1793602443037",
      "isRead": false,
      "createdAt": "2026-11-02T06:56:06.412Z",
      "user": {
        "id": "cmvy5x9be001cmvaz81z3xcw9",
        "name": "Chitra Officer (fictional)",
        "email": "officer1@niyamsetu.test",
        "role": "OFFICER"
      },
      "deficiency": {
        "id": "cmvywjs09000xy6vyh1punjvj",
        "requirement": "Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1)",
        "status": "VERIFIED",
        "applicationId": "cmvywjry5000fy6vymfy0dzv3"
      }
    },
    {
      "id": "cmvywjs3b002hy6vyamlfambn",
      "userId": "cmvy5x9b80019mvazika6aolz",
      "deficiencyId": "cmvy5xajb001dmvb3mty75wwt",
      "type": "ESCALATION",
      "message": "Escalation: FIC-008 deficiency overdue since 2026-11-01T18:37:43.895Z, owner unassigned – 4 labs is below min 6 labs (MIN_LABS v1)",
      "dedupKey": "ESCALATION:cmvy5xajb001dmvb3mty75wwt:1793558263895",
      "isRead": false,
      "createdAt": "2026-11-02T06:53:03.095Z",
      "user": {
        "id": "cmvy5x9b80019mvazika6aolz",
        "name": "Asha Admin (fictional)",
        "email": "admin1@niyamsetu.test",
        "role": "ADMIN"
      },
      "deficiency": {
        "id": "cmvy5xajb001dmvb3mty75wwt",
        "requirement": "4 labs is below min 6 labs (MIN_LABS v1)",
        "status": "OVERDUE",
        "applicationId": "cmvy5xagx000vmvb3wd3ng8ph"
      }
    },
    {
      "…": "3 more items trimmed"
    }
  ]
}
```

---

## Dashboard

All numbers are counted live and filtered by role (ADMIN all, OFFICER assigned applications,
INSTITUTION own institution). "Open" means every status except `VERIFIED`. "Overdue" means status
`OVERDUE` **or** `OPEN`/`REJECTED` past its due date (not yet marked by the engine).

### `GET /api/dashboard/summary`

| | |
| --- | --- |
| Roles | any |
| Errors | 401 |

`byStage` always contains all 6 stages. `dueSoon` uses the same window as the deadline engine.

Real response as admin1 → **200**

```json
{
  "generatedAt": "2026-11-02T06:56:06.666Z",
  "applications": 10,
  "byStage": {
    "SUBMITTED": 3,
    "SCRUTINY": 2,
    "EXPERT_VISIT": 1,
    "COMMITTEE": 1,
    "APPROVED": 2,
    "RETURNED": 1
  },
  "openDeficiencies": 4,
  "dueSoon": 0,
  "overdue": 4,
  "escalated": 4,
  "unassignedDeficiencies": 3
}
```

### `GET /api/dashboard/by-status`

| | |
| --- | --- |
| Roles | any |
| Errors | 401 |

Counts per stage for the pie chart (all 6 stages, zeros included).

Real response as admin1 → **200**

```json
{
  "byStatus": [
    {
      "stage": "SUBMITTED",
      "count": 3
    },
    {
      "stage": "SCRUTINY",
      "count": 2
    },
    {
      "…": "4 more items trimmed"
    }
  ]
}
```

### `GET /api/dashboard/workload`

| | |
| --- | --- |
| Roles | ADMIN |
| Errors | 401 · 403 |

One row per OFFICER (including officers with nothing assigned), by name.

Real response as admin1 → **200**

```json
{
  "workload": [
    {
      "officer": {
        "id": "cmvy5x9be001cmvaz81z3xcw9",
        "name": "Chitra Officer (fictional)",
        "email": "officer1@niyamsetu.test"
      },
      "assignedApplications": 6,
      "openDeficiencies": 3,
      "overdueDeficiencies": 3
    },
    {
      "officer": {
        "id": "cmvy5x9bg001emvaz8jtipyj9",
        "name": "Dev Officer (fictional)",
        "email": "officer2@niyamsetu.test"
      },
      "assignedApplications": 4,
      "openDeficiencies": 1,
      "overdueDeficiencies": 1
    }
  ]
}
```

### `GET /api/dashboard/deficiencies-by-rule`

| | |
| --- | --- |
| Roles | any |
| Errors | 401 |

`total` and `open` per rule code for the bar chart (all 5 codes, zeros included).

Real response as admin1 → **200**

```json
{
  "byRule": [
    {
      "code": "FACULTY_RATIO",
      "total": 1,
      "open": 1
    },
    {
      "code": "MIN_BUILTUP_AREA",
      "total": 1,
      "open": 1
    },
    {
      "…": "3 more items trimmed"
    }
  ]
}
```

### `GET /api/dashboard/overdue`

| | |
| --- | --- |
| Roles | any |
| Query | `limit` integer, default 50, min 1, max 200 |
| Errors | 400 validation · 401 |

Most overdue first. **Show `minutesOverdue` in DEMO_MODE.** `escalated` is `true` once the
deadline engine has escalated it.

Real response as officer1 → **200**

```json
{
  "total": 4,
  "overdue": [
    {
      "id": "cmvy5xart002fmvb3cdf3t29u",
      "requirement": "Required documents: FIRE_NOC expired 2026-09-30 (REQUIRED_DOCUMENTS v1)",
      "status": "OVERDUE",
      "rule": "REQUIRED_DOCUMENTS v1",
      "application": {
        "id": "cmvy5xapj001xmvb3ffubidtw",
        "programme": "B.Tech Computer Science",
        "institution": {
          "code": "FIC-011",
          "name": "Kosi Plains Institute of Engineering"
        }
      },
      "owner": {
        "id": "cmvy5x9bn001kmvazqr9ccixt",
        "name": "Gauri Registrar (fictional)",
        "email": "inst3@niyamsetu.test",
        "role": "INSTITUTION"
      },
      "dueDate": "2026-11-01T18:28:44.291Z",
      "hoursOverdue": 12.5,
      "minutesOverdue": 747,
      "escalated": true,
      "escalatedAt": "2026-11-01T18:30:50.848Z"
    },
    {
      "id": "cmvy5xaj70017mvb3i6c6ab62",
      "requirement": "Built-up area 7.5 sqm per student is below min 10 (MIN_BUILTUP_AREA v1)",
      "status": "OVERDUE",
      "rule": "MIN_BUILTUP_AREA v1",
      "application": {
        "id": "cmvy5xagx000vmvb3wd3ng8ph",
        "programme": "B.Tech Civil",
        "institution": {
          "code": "FIC-008",
          "name": "Sahyadri Pines Institute of Technology"
        }
      },
      "owner": null,
      "dueDate": "2026-11-01T18:32:50.976Z",
      "hoursOverdue": 12.4,
      "minutesOverdue": 743,
      "escalated": true,
      "escalatedAt": "2026-11-02T06:53:03.046Z"
    },
    {
      "…": "2 more items trimmed"
    }
  ]
}
```

---

## Audit

Each row: `id`, `createdAt`, `action` (`CREATE` `UPDATE` `STATUS_CHANGE` `LOGIN`), `entityType`,
`entityId`, `actorId`, `actorName` (**"System"** when the actor is null – seed, deadline engine,
alerts), `actorRole`, `before`, `after`.

### `GET /api/audit`

| | |
| --- | --- |
| Roles | ADMIN: all rows · OFFICER / INSTITUTION: only rows about their applications, the rule checks, deficiencies and evidence on them, the institutions behind them, their own user record and alerts sent to them |
| Query | `entityType` optional string (e.g. `Application`, `Deficiency`, `Evidence`, `RuleCheck`, `Institution`, `User`, `Alert`) · `entityId` optional string · `limit` integer, default 50, min 1, max 200 |
| Errors | 400 validation · 401 |

Newest first, with `total`.

Real response as admin1 → **200**

```json
{
  "total": 78,
  "audit": [
    {
      "id": "cmvywnppg004dy6vygx3ctiqd",
      "createdAt": "2026-11-02T06:56:06.628Z",
      "action": "STATUS_CHANGE",
      "entityType": "Application",
      "entityId": "cmvywjry5000fy6vymfy0dzv3",
      "actorId": "cmvy5x9be001cmvaz81z3xcw9",
      "actorName": "Chitra Officer (fictional)",
      "actorRole": "OFFICER",
      "before": {
        "stage": "COMMITTEE"
      },
      "after": {
        "stage": "APPROVED"
      }
    },
    {
      "id": "cmvywnpp60049y6vytx08ufq2",
      "createdAt": "2026-11-02T06:56:06.618Z",
      "action": "CREATE",
      "entityType": "Alert",
      "entityId": "cmvywnpp50047y6vy1lfv1jgo",
      "actorId": null,
      "actorName": "System",
      "actorRole": null,
      "before": null,
      "after": {
        "id": "cmvywnpp50047y6vy1lfv1jgo",
        "type": "STATUS_CHANGE",
        "isRead": false,
        "userId": "cmvy5x9bn001kmvazqr9ccixt",
        "message": "Evidence verified for FIC-012: Required documents: FIRE_NOC expired 2026-10-03 (REQUIRED_DOCUMENTS v1) – Renewed NOC checked",
        "dedupKey": "VERIFIED:cmvywnpoe003ty6vyqo5t4rog",
        "createdAt": "2026-11-02T06:56:06.617Z",
        "deficiencyId": "cmvywjs09000xy6vyh1punjvj"
      }
    },
    {
      "…": "1 more items trimmed"
    }
  ]
}
```

### `GET /api/applications/:id/audit`

| | |
| --- | --- |
| Roles | any, subject to the visibility rules |
| Query | `limit` integer, default 50, min 1, max 200 |
| Errors | 400 validation · 401 · 403 · 404 |

The application's full trail: the application itself, its rule-check runs (logged against the
application id), its deficiencies and their evidence – newest first, with `total`. Alert rows are
left out on purpose (escalations are already recorded on the deficiency).

Real response as inst3 → **200**

```json
{
  "applicationId": "cmvywjry5000fy6vymfy0dzv3",
  "total": 21,
  "audit": [
    {
      "id": "cmvywnppg004dy6vygx3ctiqd",
      "createdAt": "2026-11-02T06:56:06.628Z",
      "action": "STATUS_CHANGE",
      "entityType": "Application",
      "entityId": "cmvywjry5000fy6vymfy0dzv3",
      "actorId": "cmvy5x9be001cmvaz81z3xcw9",
      "actorName": "Chitra Officer (fictional)",
      "actorRole": "OFFICER",
      "before": {
        "stage": "COMMITTEE"
      },
      "after": {
        "stage": "APPROVED"
      }
    },
    {
      "id": "cmvywnpp20045y6vy8a0nhgln",
      "createdAt": "2026-11-02T06:56:06.615Z",
      "action": "STATUS_CHANGE",
      "entityType": "Deficiency",
      "entityId": "cmvywjs09000xy6vyh1punjvj",
      "actorId": "cmvy5x9be001cmvaz81z3xcw9",
      "actorName": "Chitra Officer (fictional)",
      "actorRole": "OFFICER",
      "before": {
        "status": "EVIDENCE_SUBMITTED",
        "dueDate": "2026-11-02T07:06:06.556Z",
        "escalatedAt": null
      },
      "after": {
        "remark": "Renewed NOC checked",
        "status": "VERIFIED",
        "dueDate": "2026-11-02T07:06:06.556Z",
        "escalatedAt": null
      }
    },
    {
      "…": "19 more items trimmed"
    }
  ]
}
```

---

## Health

### `GET /api/health`

| | |
| --- | --- |
| Roles | public |
| Errors | 500 `{ "status": "error", "db": "down" }` |

Real response → **200**

```json
{
  "status": "ok",
  "db": "up",
  "demoMode": true
}
```
