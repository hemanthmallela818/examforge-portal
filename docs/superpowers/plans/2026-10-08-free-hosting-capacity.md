# Free Hosting Student Capacity Implementation Plan

> **For agentic workers:** Execute the backend, frontend, and operational tasks against the interfaces below. Use focused parallel agents for disjoint backend and rehearsal files; integrate and verify the whole branch before completion.

**Goal:** Reduce student traffic without weakening confirmed-answer, ownership, deadline, or grading guarantees, and provide a reproducible Free-tier capacity measurement.

**Architecture:** Keep React/Vite and Supabase. One completion-scheduled poller owns each student screen. A bounded dashboard RPC and a small runtime RPC replace student Realtime; one answer-save pipeline feeds autosave and submission, carrying optional cumulative timing.

**Tech Stack:** Existing React, Supabase PostgreSQL, Node test runner, Vitest, PGlite, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-free-hosting-capacity.md`

## Global Constraints

- Strictly free hosting; no new dependencies or infrastructure.
- Student updates target randomized 20–30 seconds under normal conditions; failures back off.
- Dashboard returns at most 25 cards per page; protected papers and answer keys never enter these responses.
- Preserve old RPC signatures, scheduled finalizer, academic records, admin Realtime, and server authorization.
- No predetermined capacity claim: operating cohort is floor(70% of highest repeatedly passing hosted concurrency).
- No Codex co-author on any commit.

## Review Focus

- Lost save response: retry identical answers and expected version; identical server answers confirm the save.
- Takeover and re-grant: stale devices/generations must never write or submit another snapshot.
- Expiry during retry: freeze changes and submit only confirmed server answers.
- Hidden/offline screens and slow responses: no overlapping polls or updates after disposal; immediate return/reconnect refresh.
- Timing validation failure: reject invalid timing independently without losing valid answers or blocking grading.

## Task 1: Additive bounded database interfaces

**Files:** New migration under `supabase/migrations/20261008*`; behavioral tests in `tests/db/student-capacity.test.mjs`; generated schema reference if needed.

**Interfaces:**
- `student_dashboard_page(page_param integer DEFAULT 0)` → `{exams: [{id,title,status,class,section,created_at,questions_data: {duration,marksCorrect,marksIncorrect,marking,subjects,totalQuestions},result: score-summary|null,session: {id,exam_id,status,deadline_at,termination_reason,access_generation}|null}],has_more:boolean,server_now: timestamp}`. Identity and assignments derive exclusively from authenticated profile. Stable newest-first order; fetch 26 metadata rows to detect the next page, return only 25. Results and sessions join only the page.
- `student_exam_runtime(exam_id_param uuid)` → `{exam_status,status,deadline_at,server_now,time_left,version,access_generation,session_owned,result}`. No response arrays, paper, or keys. Assert current student session and exam assignment.
- Extend `sync_active_session_progress` with optional fifth `subject_time_seconds_param jsonb DEFAULT NULL` (replace four-argument wrapper to avoid overload ambiguity; four-argument calls still resolve). Save answers through existing internal validator, then validate timing in a subtransaction; return `timing_saved` boolean and runtime fields. Timing rejection must preserve the saved answers.
- Add runtime fields to start responses through compatible wrapper. Review ownership, assignment/order, result/session and expiry indexes; retain finalizer batch of 200.

- [x] Add and run behavioral tests for 25-row pagination, assignment filtering, no paper leakage, takeover, runtime/start/save consistency, old clients, timing rejection, expiry, and stale generations.
- [x] Implement migration and run tests through complete migration replay.

## Task 2: Student read and save paths

**Files:** `src/studentPolling.js`, `src/features/exam/useStudentPolling.js`, `src/components/StudentDashboard.jsx`, `src/components/PreExam.jsx`, `src/features/exam/useExamSession.js`, `src/features/exam/useSubjectTime.js`, `src/features/exam/examClock.js`, `src/App.jsx`; node/component tests and affected fixtures.

- [x] Add poller tests using injected timers/events: completion scheduling, randomized delay, backoff, disposal/cancellation, visibility/offline handling and postponement after saves.
- [x] Implement one reusable poller with an AbortController per read and a hook lifetime per screen. Dashboard refreshes only its current page, adds previous/next controls, and routes ownership failures to session logout. Selected exam uses only the session hook poller; instructions consume its status/error props.
- [x] Anchor server epoch to `performance.now()`; use it for countdown, save deadlines, and final-ten-second 250 ms debounce. Re-anchor from successful start/runtime/save replies.
- [x] Move answer RPC into one single-flight/latest-pending pipeline accessible to submission. Freeze editing, flush newest state, and submit its confirmed version. Retry the same payload/version; preserve existing conflict recovery and pending records.
- [x] Accrue timing with a monotonic clock and piggyback on saves. Changed-only fallback runs after 60 seconds without a successful timing save; no overlapping timing requests. Catch timing errors so grading proceeds.
- [x] Remove whole-paper image preload at start; keep private on-demand images and existing upload compression. Correct recovery copy to distinguish pending local answers from confirmed answers.
- [x] Update and run behavioral component tests for runtime ownership, saving/submitting overlap, uncertain saves, expiry, timing failure, paging, and existing termination paths.

## Task 3: Rehearsal and operator evidence

**Files:** `scripts/rehearse-staging.mjs`, `scripts/operational-health-check.mjs`, related tests, `docs/LOAD_TESTING.md`, `docs/EXAM_DAY_CAPACITY.md`; diagnostic SQL if useful.

- [x] Replace candidate Realtime harness traffic with actual dashboard/runtime polling, save piggyback timing, 60-second timing fallback, and save-aware poll postponement. Keep admin traffic, takeover and version checks.
- [x] Include full-duration/token-refresh mode, representative media/paper guidance, exact error and correctness thresholds, projected egress/database growth, and finalizer backlog/oldest deadline observations. Test new pure reporting logic.
- [x] Document progressive repeated Free-tier staging runs, 70% operating limit, shared-IP login/refresh/reconnect drills, query-plan checks with representative data, backups, additive backend-first deployment and frontend rollback.
- [x] Run local validation only unless an explicitly disposable hosted project is configured and authorized; do not reset or deploy production.

## Task 4: Integration validation

- [x] Run `npm test`, `npm run test:db`, `npm run test:components`, `npm run lint`, `npm run typecheck`, `npm run build`, and schema reference checks.
- [x] Review the complete diff against every spec requirement; run available local browser/database rehearsal where practical.
- [x] Record actual evidence and any unrun hosted checks. Leave implementation on `codex/free-hosting-student-capacity` for review.

## Verification evidence — 8 October 2026

Implementation is on `codex/free-hosting-student-capacity`.

- `npm test`: 53 test files passed.
- `npm run test:db`: 15 test files passed, including complete migration replay and the new capacity contracts.
- `npm run test:components`: 41 files / 359 tests passed.
- Lint, TypeScript, production build, schema reference check and whitespace checks passed.
- Chromium against a separate disposable local Supabase project: all six reliability, student-exam and takeover cases passed. The test stack was isolated from the developer's ordinary local project. Its Vite symlink setup emitted a font allow-list warning; behavioral assertions passed.
- The updated harness passed a five-student disposable local rehearsal with a measured 60,001 ms soak, five correct/idempotent submissions, five token refreshes and zero unexpected request errors. Dashboard/save/start/submit p95 were 7.3/12.2/26.5/22.3 ms. Local evidence does not establish a hosted cohort.
- Harness regression tests (7 passed) cover shuffled-paper answer mapping, confirmation of lost save responses and repeated-capacity reporting; the soak now waits through its configured end and validates measured duration.
- Review reproduced and fixed stale conflict recovery, access-generation queue reuse, deadline/in-flight save ordering, timing overlap and late save replies after finalization. Durable regression tests cover these paths.

## Release gates still requiring hosted evidence

No hosted Free-tier capacity run or production deployment was performed. The operating cohort remains unmeasured. Before release, apply the backend migration first and complete representative query plans, full-duration JWT refresh/media/admin runs, school-IP login/refresh/reconnect bursts, large finalizer abandonment bursts, verified database/private-storage restores and frontend rollback rehearsal. Repeat passing hosted concurrency three times and publish only its 70% operating limit. These are deployment evidence, not results inferred from local tests.
