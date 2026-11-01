# NiyamSetu – End-to-end Test Report

> **All results below were measured on synthetic, fictional data in DEMO_MODE**
> (deadlines in minutes instead of days). Institutions, people and rule thresholds
> are placeholders; no real AICTE data was used. Numbers are exactly what this run
> measured – nothing is rounded up or estimated.

| Item | Value |
| --- | --- |
| Run started | 2026-11-01T19:19:16.688Z |
| Run finished | 2026-11-01T19:19:26.611Z |
| Commit tested | `75f65f343586a2fed7797ee0259b4512f2726232` |
| Application code (apps/api/src, apps/api/prisma) | identical to the commit above |
| Other uncommitted files at run time | apps/api/package.json, apps/api/tsconfig.json, apps/api/tests/, docs/ |
| Database | niyamsetu_test (reset and seeded at start) |
| Mode | DEMO_MODE=true, DISABLE_CRON=true, API on port 4100 |
| Node.js | v26.7.0 |
| Reproduce | `cd apps/api && npm test` |

## Summary

- Total tests: **164**
- Passed: **164**
- Failed: **0**

## Results per area

| Area | Tests | Passed | Failed |
| --- | ---: | ---: | ---: |
| 1. 9-step demo flow | 17 | 17 | 0 |
| 2. RBAC | 47 | 47 | 0 |
| 3. Rules engine | 22 | 22 | 0 |
| 4. Deadline engine (injected time) | 6 | 6 | 0 |
| 5. Evidence upload | 12 | 12 | 0 |
| 6. Audit log | 18 | 18 | 0 |
| 7. Validation and error handling | 42 | 42 | 0 |

## Brief metrics

### 1. Deadline detection

12 of 12 deficiencies were classified correctly by a single deadline-engine run (100.0%). Due dates were placed around an injected time T: 7 past due, 3 inside the 3-minute due-soon window, 2 outside it; 5 were past the 2-minute grace period.

Detection latency: one engine run. The cron schedule runs the engine every minute; the deficiencies were detected in the first run at T, with no further runs needed.

### 2. Alert correctness

17 of 17 expected alerts were delivered to the right recipient with the right type (100.0%). Unexpected alerts: 0. Duplicate alerts after 5 further engine runs: 0.

Recipients covered: deficiency owner, owner's manager (escalation), assigned officer (no owner), assigned officer's manager (escalation without owner), all ADMIN users (no owner and no officer).

### 3. Deficiency traceability

51 of 51 deficiencies in the test database have a complete chain (100.0%): rule check → exact rule version → CREATE audit row, and for the 6 VERIFIED deficiencies also evidence → verifying officer → verification time.

Missing links: rule version 0, CREATE audit row 0, verification record 0.

## Notes

- Extra fictional INSTITUTION logins used by the tests are inserted directly into the test database (there is no user-creation route).
- Deadline tests call the engine function `runDeadlineCheck(now)` with an injected time against the same test database; the HTTP fallback route is covered in the RBAC tests.
- Upload files created by the tests are deleted after the run; only files recorded in the test database's Evidence rows are removed.
