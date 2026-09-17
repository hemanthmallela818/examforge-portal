# Production Readiness Security Audit

Original audit date: 10 September 2026  
Closure update: 17 September 2026  
Scope: security, authorization, data integrity, account isolation, exam continuity, operational safeguards, and evidence through Stages 1 through 26.

## Executive verdict

**NO UNRESOLVED CRITICAL OR HIGH LOCAL SECURITY DEFECT IS CURRENTLY KNOWN. THE PORTAL IS READY FOR CONTROLLED STAGING, NOT LIVE PRODUCTION.**

Stages 1 through 11 established the core server-owned examination architecture, AAL2 administrator security, lifecycle controls, offline recovery, immutable grading, asset validation, accessibility foundations, and operational tooling. Stages 12 through 26 closed paging, export, disclosure, Data API, privileged-function, device-takeover, import, browser, accessibility, release-rehearsal, historical-constraint, and restore-proof gaps.

The final local evidence is:

- 61 forward-only migrations rebuild cleanly from an empty local database.
- The database advisor reports zero schema warnings.
- 237 of 237 automated checks pass across 38 test files.
- 39 of 39 browser scenarios pass across Chromium, Firefox, and WebKit.
- The 80-candidate local rehearsal reports zero lost/cross-account answers, duplicate results, unauthorized operations, or unhandled server errors.
- Populated logical-database and private-Storage restore proofs pass with matching content hashes.
- Lint, production build, operational health, and dependency audit pass.
- No remote project, deployment, secret, or production data was changed.

## Trust-boundary conclusion

The browser is not trusted to authorize administrative work, reveal answer keys, keep authoritative time, grade submissions, decide session ownership, or resolve lifecycle races.

- Anonymous users have no examination, roster, result, session, or maintenance access.
- Students receive only their assigned metadata and active paper content at the authorized lifecycle point.
- Students cannot read other candidates' roster rows, sessions, answers, or results.
- AAL1 administrator sessions cannot perform protected administrative operations.
- AAL2 administrator sessions use explicit RLS/RPC grants for necessary operations.
- Service-role access is reserved for server-owned provisioning and operational contexts.
- New Data API objects are not exposed by default.
- Raw papers, answer keys, trigger helpers, validators, reconstruction helpers, audit helpers, and cleanup primitives are not browser-callable.

## Critical risk closure

### Account provisioning and administrator authentication

Status: **locally resolved**

- Public self-enrolment into the application roster is blocked.
- Student accounts are provisioned through the server-owned function and finalized atomically; application tables contain no passwords.
- Administrator functions and RLS require a current AAL2 JWT claim.
- TOTP enrollment, denial, verification, and recovery boundaries have automated coverage.
- Password whitespace is preserved and new student passwords are length/complexity bounded.

### Question and answer disclosure

Status: **locally resolved**

- Candidate pre-start views contain metadata only.
- Answer keys are isolated in the private server-owned relation and are absent from student REST/RPC/Realtime responses.
- Raw exam-paper Realtime publication was removed in favor of a metadata-only surface.
- Browser roles have explicit column grants rather than broad roster-table reads.
- Archive attribution and reason fields are not directly readable by browser roles.
- Private image access uses short-lived signed URLs and validated private Storage objects.

### Authorization and RLS bypass

Status: **locally resolved**

- Exposed tables, views, RPCs, and Storage boundaries have an explicit actor matrix.
- Schema creation and future implicit browser exposure are disabled.
- SECURITY DEFINER routines use empty search paths and qualified object references.
- Authoritative functions check the caller's role, AAL2 level, student ownership, signed session, lifecycle state, and bounded input as applicable.
- Function execution is revoked by default and browser-facing RPCs are allowlisted.
- Crafted direct writes to exams, results, sessions, provisioning, audit logs, and maintenance operations are rejected.

### Grading and academic-record integrity

Status: **locally resolved**

- Exam paper creation, answer-key storage, timing, submission, grading, and termination are server-owned.
- Results are immutable academic records.
- Repeated or ambiguous submissions return the same committed result.
- Numerical input uses a shared strict decimal policy and server-owned tolerance.
- Result ranking and analytics normalize database numeric values and reject malformed/duplicate rows.
- Export preparation verifies the authoritative count, requires AAL2, and writes an audit event.
- The rehearsal verified 80 distinct answer fingerprints against 80 exact result records.

### Exam lifecycle and recovery

Status: **locally resolved**

- Lifecycle transitions are enforced in PostgreSQL.
- In-flight paper, timing, and scoring fields cannot be changed.
- Ended exams with submissions cannot be silently reactivated or deleted.
- Server time controls the deadline; autosave uses optimistic versions.
- Submission and termination are concurrency-safe and idempotent.
- The 180-second recovery grace cannot change the authoritative graded snapshot after the allowed boundary.
- Offline recovery records are schema-versioned and isolated by student and exam.
- Corrupt, foreign, blocked, and quota-failed browser storage paths fail safely.
- A response lost after a committed submission is reconciled to the one stored result.

### Automatic device takeover

Status: **locally resolved with an explicit limitation**

- The newest authenticated login atomically replaces the previous student session.
- The previous identifier is never returned to the browser.
- Takeover audit records exclude tokens, answers, and question content.
- The old device becomes read-only after authoritative rejection, preserves its local copy, cannot mutate the attempt, and signs out locally without revoking the new session.
- The new device resumes the latest server-confirmed autosave.

Answers that existed only in offline storage on the lost or disconnected old device cannot be recovered on the new device. The UI warns about this; accepting automatic takeover explicitly accepts this limitation.

### Reviewed JSON import and assets

Status: **locally resolved**

- The portal is JSON-only and makes no PDF, OCR, image-extraction, or AI-parsing claim.
- Every valid source row requires explicit human approval.
- Files and nested values are bounded before expensive processing.
- Encoding errors, deep nesting, truncation, duplicate identifiers/text, malformed options, invalid numerical zero handling, LaTeX imbalance, and missing diagrams are rejected.
- Import commit is atomic, duplicate-safe, and idempotent.
- Ambiguous commit responses retain the batch identity for reconciliation.
- Image type is verified from magic bytes and checked against declared MIME and dimensions before upload.
- Referenced assets are retained; unreferenced cleanup is audited; failed uploads roll back.

## Performance and scale evidence

- Administrator roster, Question Bank, exam list, and result list use bounded server-side pagination.
- Export collection is bounded and count-verified.
- Rehearsal query plans used supporting indexes for the page-sized roster, ranked-result, session, and active-exam paths.
- Observed local executions were below 0.5 ms on the 80-candidate rehearsal data set.
- Heavy chart and PDF dependencies are lazy-loaded.
- No production chunk exceeds 500 kB.

This is correctness and small-rehearsal evidence, not a substitute for peak or sustained staging load.

## Browser and accessibility evidence

Chromium, Firefox, and WebKit each pass the complete 13-scenario local matrix (39 executions total):

- Student and administrator login.
- AAL2 denial and successful TOTP verification.
- Reviewed JSON import, exam assembly, activation, ending, and export.
- Student start, answer, reload, offline work, reconnect, submit, and result revisit.
- Automatic device takeover.
- Administrator and student retry/error states.
- REST 401/403 recovery, Realtime outage, storage quota denial, and response-after-commit loss.
- Focus trapping/return, live announcements, reduced motion, forced-colors behavior, and responsive active-exam behavior.

Native Firefox still cannot launch on this Windows host (`spawn UNKNOWN` before application code). The complete Firefox matrix therefore ran successfully in Microsoft's pinned Playwright 1.63.0 Linux image using local-only Docker host networking. Hosted Linux CI remains unexecuted because this workspace has no Git repository/remote and this work includes no push.

## Operational safeguards

- A local-only AAL2 rehearsal runner refuses remote hosts.
- The staging runner requires an exact project-reference/hostname match and an explicit disposable-project confirmation.
- The operational check is read-only and reports actionable counts without student details.
- CI starts local Supabase, resets all migrations, and runs authenticated critical flows in Chromium, Firefox, and WebKit.
- Point-in-Time Recovery (PITR), logical backup, private-Storage recovery, MFA recovery, and incident procedures are documented.
- The populated local database restores into an isolated temporary database with matching row digests and zero unvalidated public constraints; a private asset restores with an identical SHA-256 hash while anonymous reads remain denied.
- Unsupported local Windows analytics/log shipping is disabled, eliminating the Vector container crash loop without changing hosted production observability.
- CI configuration is locally reviewed but remains unexecuted until pushed by the project owner.

## Residual risk register

### Staging-only release blockers

1. Complete the isolated staging 80-candidate run using real network boundaries and staging secrets.
2. Obtain a passing hosted Linux CI result for Chromium, Firefox, and WebKit; the same matrix already passes locally across Windows plus the pinned Linux Firefox container.
3. Run peak, soak, reconnect-storm, and simultaneous-submit load at the institution's expected concurrency.
4. Repeat the passing local database/private-Storage restore proofs in isolated staging and record RPO/RTO and restoration ownership.
5. Rehearse lost MFA factor, service outage, partial campus connectivity, emergency termination, rollback, and candidate communication.
6. Perform supported-device and assisted screen-reader acceptance with representative users.

### Deployment and hosting blockers

1. Verify CSP, HSTS, frame-ancestors, Referrer-Policy, Permissions-Policy, X-Content-Type-Options, TLS, and cache behavior on the real domain.
2. Tune Auth, REST, RPC, Edge Function, Storage, and WAF/rate limits from measured load.
3. Configure secret separation/rotation, least-privilege operator access, and environment-specific project controls.
4. Configure error monitoring, structured logs, SLOs, latency/error/capacity alerts, audit alerts, and on-call routing.
5. Enable and monitor backup/PITR and private-asset recovery; approve retention and privacy rules.
6. Assign incident roles and run recovery drills before any high-stakes examination.

## Final security decision

The local implementation satisfies the planned security and integrity acceptance criteria. It may advance to isolated staging. It must not be called production-ready until the staging-only and deployment/hosting blockers above have objective evidence and named operational owners.
