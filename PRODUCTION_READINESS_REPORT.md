# Production Readiness Report

Audit date: 17 September 2026  
Scope: local repository, React browser application, Supabase schema and migrations, administrator and student workflows, security boundaries, recovery behavior, build output, dependencies, and release tooling.  
Deployment status: no deployment, push, remote migration, secret change, or production-data operation was performed.

## Verdict

**LOCAL RELEASE CLOSURE PASSES. THE APPLICATION IS READY FOR AN ISOLATED STAGING REHEARSAL, BUT IT IS NOT YET APPROVED FOR LIVE PRODUCTION.**

Stages 1 through 26 are implemented locally. The repository has no unresolved critical or high defect currently known in authorization, answer disclosure, grading integrity, account isolation, duplicate submission handling, or exam recovery.

Production approval remains intentionally blocked on environment-dependent evidence: an isolated staging run, an actual remote CI run, real peak/soak tests, a timed staging backup/restore drill, hosting-header verification, monitoring, rate-limit tuning, and incident rehearsal.

## Final local evidence

- Forward-only database history: **61 migrations**, rebuilt successfully from scratch with the project-pinned Supabase CLI.
- Database advisor: **PASS**, with zero schema warnings after the clean reset.
- Automated repository tests: **237/237 PASS** across **38 test files**.
- Browser automation: **39/39 PASS**: all 13 scenarios in Chromium, Firefox, and WebKit. Firefox was executed in Microsoft's pinned Playwright Linux image because the Windows host cannot launch the patched Firefox process.
- Critical browser paths: **21/21 PASS** across Chromium, Firefox, and WebKit.
- Syntax and source checks: **PASS**.
- Production Vite build: **PASS**.
- Dependency audit: **PASS**, zero known vulnerabilities.
- Bundle limit: **PASS**. The largest production chunk is the lazy-loaded PDF library at approximately 399.67 kB, below the 500 kB warning threshold.
- Operational health check: **HEALTHY**, with no expired sessions pending, missing question media, inactive students, unreferenced storage assets, or reported issues.
- Local 80-candidate rehearsal: **PASS** with zero lost or cross-account answers, zero duplicate results, zero unauthorized operations, and zero unhandled server errors.
- Logical database restore: **PASS** with matching row counts and SHA/MD5 content digests for the populated 80-candidate data set and zero unvalidated public constraints.
- Private Storage restore: **PASS** with anonymous access denied, signed access verified, and an identical SHA-256 hash after export, removal, and restoration.
- Local container health: **PASS** with no crash-looping collector; unsupported Windows local analytics/log shipping is disabled.

## 80-candidate rehearsal results

The local runner created an AAL2 administrator and 80 disposable candidates on the local Supabase stack. It exercised unique grading fingerprints so one candidate's answers could not be mistaken for another's.

- 80 students created and finalized through the same provisioning boundary used by the application.
- 80 students authenticated and claimed signed sessions.
- 80 Realtime subscriptions opened.
- 80 exam sessions started.
- 80 answer sets autosaved.
- 80 results submitted.
- 80 repeated submissions returned the same committed outcomes.
- Direct student reads did not reveal the answer key.
- Cross-account sessions and results were not visible.
- Forged result writes, forged exam writes, and student-side provisioning were rejected.
- The final database contained exactly 80 unique results and no remaining active sessions.

The harness deliberately leaves immutable academic records in the disposable target and reports that the target must be reset. This is expected and prevents a cleanup routine from weakening record-retention guarantees. The guarded remote runner remains in `scripts/rehearse-staging.mjs`; its project reference must match the exact Supabase hostname and the operator must explicitly confirm the target is disposable.

## Completed production-readiness stages

### Stage 20 - Question-disclosure protection

- Candidate pre-start access is metadata-only; raw papers and answer keys remain server-owned.
- Broad roster reads were removed from browser roles.
- Authenticated roster access is limited to the explicit columns needed for identity, RLS, duplicate checks, and session Realtime.
- Archive audit fields cannot be retrieved through direct student-table reads.
- Assigned, unassigned, archived, anonymous, student, and AAL2-administrator access paths have database tests.

### Stage 21 - Database, RLS, and privileged-function hardening

- Local Data API exposure is deny-by-default and future objects require explicit grants.
- Browser roles cannot create objects in exposed schemas.
- Default privileges and an authorization manifest define access for anonymous users, students, AAL1 administrators, AAL2 administrators, and the service role.
- Browser-callable RPCs are allowlisted; trigger, reconstruction, validator, audit, and cleanup helpers remain internal.
- Authoritative security-definer functions use empty search paths, qualified object references, explicit caller checks, and bounded input.
- Raw papers, answers, private Storage assets, other students' sessions/results, and audit metadata are denied through direct tables, views, RPCs, filters, and Realtime.

### Stage 22 - Exam continuity and automatic device takeover

- The newest authenticated student login atomically replaces the previous signed session.
- The RPC reports only whether a replacement occurred and never returns the old session identifier.
- Takeovers are audited without tokens, answers, or question content.
- The new device warns that it can recover only the latest server-confirmed autosave.
- A rejected old device becomes read-only immediately, keeps its isolated local recovery copy, cannot autosave/submit/terminate, and signs out without revoking the new device.
- Simultaneous login, duplicate-tab, offline-old-device, reconnect, takeover-during-submit, deadline, grace-period, and unknown-outcome behavior is covered by database, unit, and browser tests.

Answers stored only in offline storage on a lost device are intentionally unrecoverable by another device. This is a documented safety boundary, not silent data loss.

### Stage 23 - Reviewed JSON import and asset safety

- The portal imports reviewed JSON only. It does not claim to parse PDF, image, OCR, text, or AI output.
- Misleading AI/PDF wording was removed and a downloadable JSON example/schema is provided.
- Unsupported file types, MIME disagreement, malformed UTF-8, BOM/encoding problems, truncation, excessive depth, oversized strings/files, and batches above 500 rows are rejected.
- Valid rows require explicit human approval.
- Duplicate source IDs/text, malformed MCQs, invalid numerical answers including mishandled zero, unbalanced LaTeX, and missing required diagrams are blocked.
- Commit is atomic and idempotent; an ambiguous response retains the same batch ID for safe reconciliation.
- Private image magic bytes, MIME, dimensions, signed-URL lifetime, failed-upload rollback, and reference-aware cleanup are tested.

### Stage 24 - Authenticated browser coverage, accessibility, and cleanup

- Deterministic local fixtures drive administrator, student, class, exam, result, MFA, and takeover scenarios.
- Browser automation covers login, MFA denial/success, JSON import, exam assembly/lifecycle, offline recovery, reconnect, idempotent submission, result revisit, device takeover, retry states, and CSV/PDF exports.
- Failure injection covers REST 401/403 responses, Realtime outage, storage quota denial, and response loss after a committed submission.
- Focus trapping and return, Escape behavior, live announcements, reduced motion, forced colors, and responsive exam behavior have automated coverage.
- Operations/Audit and Database Cleaner rendering were extracted from the oversized dashboard controller after behavior coverage existed.
- Heavy analytics and PDF code remain lazy-loaded.

One WebKit run exposed a real controlled-checkbox timing issue. The handler now captures the checkbox value before updating React state, and the test confirms each selection before continuing. The affected test and the complete matrix pass after the correction.

### Stage 25 - Local release closure

- The rehearsal harness now verifies unique per-candidate answer fingerprints, exact result cardinality, cross-account isolation, authorization denial, and idempotent unknown-outcome recovery.
- A local-only runner provisions a temporary AAL2 administrator without accepting a remote host.
- The health check supports a guarded local mode.
- Database-advisor hygiene findings were corrected in a new forward-only, fail-closed migration without changing existing routine signatures or behavior.
- Production page queries use supporting indexes; observed local execution times for roster, ranked-result, active-session, and active-exam lookups were below 0.5 ms on the rehearsal data set.
- CI now starts a clean local Supabase stack and runs authenticated critical paths in Chromium, Firefox, and WebKit.

### Stage 26 - Legacy constraint closure and restore proof

- A forward-only migration validates all five historical `NOT VALID` application constraints after the cleanup migrations.
- A clean 61-migration replay succeeds, the database linter reports no schema errors, and PostgreSQL reports zero unvalidated public constraints.
- A repeatable local restore proof creates an isolated temporary database, restores a logical dump using the Supabase-managed local role, compares critical-table row digests, checks constraint state, and removes the temporary database and dump.
- A repeatable private-Storage proof exports, removes, restores, hashes, signed-reads, and cleans a private `exam-assets` fixture.
- Supabase CLI use is project-pinned and telemetry-free; local Windows analytics is disabled to eliminate the unsupported Vector log-socket crash loop.

## Browser status

- Chromium: complete local matrix passes.
- WebKit: complete local matrix passes.
- Firefox: complete local matrix passes in Microsoft's version-matched Playwright 1.63.0 Linux image. The native Windows launch still fails before application code with `spawn UNKNOWN`; this is a host tooling limitation, not an untested browser path.
- Linux CI is configured to run the critical three-browser paths. Its actual hosted result remains pending because this workspace has no Git repository/remote and no push is included in this work.

## Remaining staging-only gates

Before production approval, run all of the following against a disposable, isolated staging project:

1. Apply all 61 migrations from an empty database and rerun database advisors.
2. Run the guarded 80-candidate staging rehearsal and confirm exact result/session cardinality.
3. Obtain a hosted Linux CI result for the checked-in three-browser critical matrix.
4. Run realistic network shaping, disconnect/reconnect, long tab suspension, device takeover, and grace-boundary tests using the real staging network.
5. Run peak and sustained load tests at the expected campus concurrency, including authentication, autosave, Realtime, submission, exports, and maintenance jobs.
6. Repeat the now-passing database and private-Storage restore proofs against isolated staging; record measured RPO/RTO and operational ownership.
7. Verify email, MFA recovery, operator access, service-role rotation, and emergency exam termination procedures.
8. Complete an assisted manual accessibility session with the institution's supported screen reader and devices.

## Deployment and hosting controls still required

These cannot be proven by repository-only testing:

- A restrictive Content Security Policy, HSTS, frame protection, Referrer-Policy, Permissions-Policy, MIME sniffing protection, and correct cache headers.
- TLS/domain configuration and separation of staging and production secrets.
- Supabase Auth, REST, RPC, Storage, and Edge Function rate limits tuned using load evidence.
- Backups/PITR, restore monitoring, private-Storage recovery, retention schedules, and deletion governance.
- Centralized error reporting, structured logs, availability/latency alerts, audit-event alerts, and capacity dashboards.
- On-call ownership, incident severity definitions, communication templates, rollback criteria, and periodic drills.

## Release decision

The local codebase and local database stack meet the plan's acceptance criteria. Proceed to an isolated staging rehearsal. Do not approve a live examination until every staging and deployment control above has evidence and an accountable owner.
