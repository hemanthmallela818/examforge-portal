# CBT Examination Portal — Production Readiness Plan

> **Historical baseline (superseded):** This document records the findings and plan from 11 September 2026. Its B-1, B-2, and B-3 blockers have since been fixed and regression-tested. Use the root `PRODUCTION_READINESS_REPORT.md` and `PRODUCTION_READINESS_AUDIT_2026-09-10.md` for the current 17 September 2026 verdict and evidence.

**Application:** `exam-portal` (CBT Examination Portal) — online Computer-Based Test platform
**Repository root:** `MockTest-main/`
**Target scale:** ~1,000 concurrent students, 10–20 administrators
**Stack (as built):** React 19.2 + Vite 8.1 (front end) · Supabase / PostgreSQL (auth, data, RPC, Realtime, Storage)
**Document date:** 2026-09-11
**Scope:** Everything except deployment. Harden the code that exists today; treat the current implementation (not the stale PRD) as the intended production scope.

---

## 1. Executive summary

The application is **architecturally strong and unusually well hardened at the data layer**, but it is **not production‑ready today** because of one crash‑level front‑end defect and two high‑severity functional/integrity defects. None of the three is subtle once located; all three are fixable with contained, low‑risk changes. The security posture of the database (row‑level security, server‑authoritative scoring, answer‑key isolation, MFA‑gated admin writes, immutable results) is a genuine asset and must be preserved rather than rebuilt.

**Go / no‑go verdict: NO‑GO until the three release‑blockers below are fixed and verified.** After they are resolved and the test/QA gate in §10 passes, the application is a strong candidate for production.

### Release blockers (must fix before launch)

| # | Severity | Area | One‑line |
|---|----------|------|----------|
| B‑1 | **Critical** | Front end | Admin dashboard crashes on mount — `activeExamId` used in a `useEffect` before its `useState` declaration (temporal dead zone → `ReferenceError`). |
| B‑2 | **High** | Front end | Leaderboard CSV **and** PDF export always fail — handlers are called with the wrong argument shape, so an integrity guard throws every time. |
| B‑3 | **High** | Backend / exam integrity | Students can read the full (answer‑less) question paper for an assigned exam **before it starts** by querying the `cbt_exams_raw` table directly through PostgREST, bypassing the safe view. |

The remaining findings (§5) are medium/low and can be addressed in the same hardening pass or scheduled as fast‑follows; none by itself blocks launch.

### Important scoping note — the PRD is stale
`testsprite_tests/tmp/prd_files/prd.md` describes a **Firebase** backend, **WebRTC webcam proctoring**, and **PDF.js question parsing**. **None of these exist in the codebase** — the real backend is Supabase, and there is no webcam or PDF‑parsing code. Per the agreed scope these PRD‑only features are **out of scope** (see §9); this plan hardens what is actually implemented.

---

## 2. Scope, method, and constraints

### In scope
Security, data integrity, reliability/resilience, correctness of the implemented feature set (auth, exam lifecycle, anti‑cheat, offline recovery, scoring, results/exports, admin CRUD, AI question import), automated‑test coverage, accessibility, performance/scale considerations, and operational/documentation hygiene.

### Method
Static source review of the entire front end (`src/`), the full Supabase migration history (`supabase/migrations/`, 40 files), operational scripts (`scripts/`), and the existing `node --test` suite. Three parallel deep‑review passes (logic modules, React components, SQL/scripts) followed by **first‑hand verification of every release‑blocker against exact source lines**. Findings below cite `file:line`.

### Constraint that shapes execution (read this)
The isolated Linux sandbox that would normally run `npm`, `node --test`, and `vite build` **cannot reach this machine's `C:` drive** (a Windows update released 2026‑09‑08 broke the mount; confirmed still broken on 2026‑09‑11). Consequences:

- All code and tests in this engagement are authored and reviewed with file tools and cross‑checked statically, **but cannot be executed here.**
- Every deliverable that must be *run* (the Node test suite, lint, `vite build`, and especially the Supabase migration for B‑3) ships with **exact commands and a validation checklist for you to run**, and is clearly labelled "authored, not executed here."
- This is why B‑3's fix is delivered as a **reviewed migration + staging validation checklist** rather than an applied change: shipping an unvalidated security migration to production would be worse than the documented, contained risk.

---

## 3. As‑built architecture snapshot

**Front end.** `src/main.jsx` boots through an error boundary + global error handlers and a runtime‑config guard (`src/runtimeConfig.js` validates the Supabase URL/key, HTTPS, and browser capabilities before the app renders). `src/App.jsx` (~1,300 lines) is the orchestrator: an `examState` machine (`AUTH → STUDENT_DASHBOARD / ADMIN_DASHBOARD → PRE_EXAM → ACTIVE → TERMINATED / SUBMITTED`), a server‑authoritative countdown (driven by an absolute `endTime`, not client ticks), version‑based autosave with exponential‑backoff retry, a session‑hijack Realtime listener, and the anti‑cheat traps (fullscreen enforcement, blur/visibility detection, keyboard lockdown, 3‑strike termination). `src/examLogic.js` holds the offline‑recovery and submission logic (schema‑versioned, ownership‑checked, idempotent).

**Back end.** PostgreSQL via Supabase. Reads and writes flow through **`SECURITY DEFINER` RPCs** and **row‑level security**, not raw table access, for the sensitive paths. Key properties confirmed in the migrations:
- **Answer‑key isolation.** The `INSTEAD OF` trigger `handle_cbt_exams_modification` strips `correctAnswer` from every question on write and stores keys in a separate `cbt_exam_answers` table (`20260823000000_schema.sql`, superseded/kept through `20260910160000`). The client‑facing `cbt_exams` view returns questions **without** the `questions` array for non‑admins (`20260910160000:723‑730`).
- **Server‑authoritative exam + scoring.** `start_exam_session` serves a server‑owned, randomised paper; scoring happens server‑side; results are made immutable (UNIQUE + revoked DML + trigger).
- **Admin MFA (AAL2).** Admin writes require `is_admin_aal2()`.
- **Single active session.** `claim_student_session` binds exam operations to the signed JWT session; hijacks are detected over Realtime.
- **Offline resilience.** Idempotent submission + preserved resume progress across the RPCs (`20260910030000`, `20260910080000`).

This is a mature design. The blockers below are defects *within* it, not gaps *in* it.

---

## 4. How the three blockers were verified

- **B‑1 (crash):** `AdminDashboard.jsx:113‑115` is a `useEffect` whose body and dependency array both reference `activeExamId`; the binding is not declared until `AdminDashboard.jsx:123` (`const [activeExamId, setActiveExamId] = useState(null)`). Because a component body executes top‑to‑bottom and `const` bindings sit in the temporal dead zone until their declaration runs, evaluating the dependency array `[activeExamId, …]` at line 115 throws `ReferenceError: Cannot access 'activeExamId' before initialization` on the **first render**. The existing test suite (`node --test tests/*.test.mjs`) never renders a React component, so nothing catches it.
- **B‑2 (exports):** `downloadLeaderboardCsv(examId, expectedCount, examTitle)` (`:1886`) and `downloadLeaderboardPDF(examId, expectedCount, examTitle)` (`:1915`) are invoked as `downloadLeaderboardCsv(exam.id, rankedResults, examSubjects, exam.title)` (`:2085`) and the PDF equivalent (`:2095`). The second parameter (`expectedCount`, expected to be an integer) receives the `rankedResults` **array**, so the export‑integrity guard `parsed.resultCount !== expectedCount || parsed.total !== expectedCount` (`:1863`) — a number‑vs‑array `!==` — is **always true** and throws *"The result set changed while the export was being prepared."* every time. The title argument is likewise shifted. Result: leaderboard CSV/PDF export is 100% broken.
- **B‑3 (pre‑disclosure):** `authenticated` holds `GRANT SELECT ON public.cbt_exams_raw` (`20260910090000_deep_exam_data_validation.sql:500`) and the row policy `cbt_exams_read_assigned` (`20260909060000:29‑39`) authorises any student for exams matching their class/section **with no exam‑status predicate**. The `cbt_exams` *view* is safe (it strips `questions` for non‑admins), and the app UI only ever reads the view — but PostgREST exposes the base table, so `GET /rest/v1/cbt_exams_raw?select=questions_data&id=eq.<examId>` with a student JWT returns the full paper (question text + options + asset references), answer‑less, regardless of whether the exam has started. The answer key is **not** exposed (it lives in `cbt_exam_answers`). Impact is exam integrity (advance sight of questions), not score manipulation.

---

## 5. Findings register

Severity: **Critical** (crash/loss) · **High** (integrity or core feature broken) · **Medium** (correctness/robustness) · **Low** (hygiene).

### Blockers
- **B‑1 · Critical · `AdminDashboard.jsx:113‑123`** — use‑before‑declaration crash (details §4). **Fix:** move the `activeTab` and `activeExamId` `useState` declarations (`:122‑123`) above the first `useEffect` (`:96`).
- **B‑2 · High · `AdminDashboard.jsx:2085,2095`** — export handlers called with wrong args (details §4). **Fix:** call `downloadLeaderboardCsv(exam.id, <authoritative total count>, exam.title)` and the PDF equivalent; drop the stray `examSubjects` arg. **Must confirm the correct count variable** (the total result count for the exam, e.g. `resultOverallCount` — **not** `rankedResults.length`, which is one page of up to 100) by reading the render scope before editing.
- **B‑3 · High · `20260909060000` + `20260910090000:500`** — question pre‑disclosure via direct table access (details §4). **Fix:** deliver as a reviewed migration (recommended approach: keep the base‑table grant to *safe columns only* so Realtime keeps working, route `questions_data` through a `SECURITY DEFINER` manifest function invoked by the view, and add a status‑aware guard) **plus a staging validation checklist**. Not applied blindly.

### Medium
- **M‑1 · `examPreflightLogic.js:113`** — preflight can throw on a `null`/non‑object question entry instead of reporting it as an invalid question; a single malformed question aborts the whole preflight. Harden to treat non‑objects as invalid rows.
  → **Resolved.** Guard added at `examPreflightLogic.js:116‑119` (non‑object rows are reported as malformed and skipped, and still counted). Regression test: `tests/stage20-medium-hardening.test.mjs` ("M‑1").
- **M‑2 · `resultPaging.js` (`finiteNumber`, ~:3)** — loose numeric coercion can turn `null`/`''`/`false` into `0`/`1` in the *results paging* path (distinct from the strict `finiteNumber` in `resultExportLogic.js`, which is correct). Tighten to reject non‑numeric inputs so paginated result counts can't silently drift.
  → **Resolved.** Strict `finiteNumber` now rejects `null`/`undefined`/`''`/boolean before `Number()` (`resultPaging.js:3‑13`), mirroring `resultExportLogic.js`. Regression test: `tests/stage20-medium-hardening.test.mjs` ("M‑2") covers total/max score and analytics average.
- **M‑3 · `importLogic.js:31`** — AI/import question type `NAT` is not mapped to the internal `NUMERICAL` type, so numeric‑answer questions imported as `NAT` are mishandled. Add the mapping.
  → **Resolved.** `NAT` is normalized to `NUMERICAL` on ingest (`importLogic.js:31‑36`), consistent with migration `20260910110000`, the preflight, and the archive. Numeric‑answer validation is unchanged (a `NAT` row with a non‑numeric answer is still rejected). Regression test: `tests/stage20-medium-hardening.test.mjs` ("M‑3").
- **M‑4 · `runtimeDiagnostics.js:16`** — diagnostic redaction leaks a bearer token substring (redaction slices *after* a regex match) and the regex is vulnerable to catastrophic backtracking (ReDoS) on hostile input. Replace with a bounded, anchored redaction that removes the whole token.
  → **Resolved.** Input is capped to 4,000 chars *before* any regex pass (bounds the work — `runtimeDiagnostics.js:12‑24`) and an explicit `bearer …` rule removes opaque (non‑JWT) tokens whole. Regression tests: `tests/stage20-medium-hardening.test.mjs` ("M‑4": opaque token, dotted JWT, oversized‑input timing); existing `tests/runtime-reliability.test.mjs` still passes (verified by inspection — jwt→`REDACTED_TOKEN`, `password=`, `&apikey=`, email cases unaffected).
- **M‑5 · `imageValidation.js:102`** — validation *fails open* when `Image` is undefined (e.g. non‑DOM contexts), allowing unvalidated images through. Fail closed when the capability is absent.
  → **Deferred — no code change (documented residual risk).** The `Image`‑undefined branch is unreachable in a production browser (`Image` is always defined there); it is a deliberate test shim, and no runtime code path or test imports `inspectImageDimensions`/`validateImageUpload` (confirmed by a path‑scoped search). Client image‑dimension checks are advisory only — the **authoritative** control is server‑side (`preflight_validate_exam` and the Storage‑path allowlist), which rejects disallowed assets regardless of the client. Changing the shim yields no production benefit and risks breaking the test doubles that rely on it. Revisit only if these functions are ever executed outside a DOM (e.g. in an SSR/worker path).
- **M‑6 · `utils.js:7‑45`** — the custom alert/confirm/prompt promises can hang forever if no listener is mounted (no timeout/rejection path), which can wedge a flow that `await`s them. Add a guard so they resolve/reject deterministically.
  → **Resolved (two coupled edits).** `requestDialog` now dispatches a **cancelable** `show-dialog` event; the mounted host acknowledges by calling `preventDefault()` (`CustomPopupContainer.jsx:20‑35`). If no host consumes the event, `dispatchEvent` returns `true` and the promise resolves a safe default (`confirm`→`false`, `prompt`→`null`, `alert`→`undefined`) instead of hanging (`utils.js:7‑27`). The happy path is preserved because dispatch is synchronous. **Coupling note:** the two files must move together — reverting only `CustomPopupContainer.jsx` would make every dialog resolve its fallback. Regression test: `tests/stage20-medium-hardening.test.mjs` ("M‑6") exercises both the no‑host and acknowledged‑host paths against an `EventTarget` shim.
- **M‑7 · `StorageImage.jsx:4,114`** — renders arbitrary `https:`/`data:` image URLs with no allowlist. Constrain to the Supabase Storage origin (and/or signed‑URL host) to prevent rendering off‑origin or crafted `data:` payloads.
  → **Deferred — no code change (documented residual risk).** Residual risk is low and already mitigated upstream: `examPreflightLogic` (`:151‑161,191‑201`) and the DB `preflight_validate_exam` reject external `https:`/`data:` image URLs at authoring/activation (and only AAL2 admins author), while a `data:` image rendered via `<img>` cannot execute script. `isDirectImage` is shared by the signing/caching path (`preloadExamImages`, `getCachedSignedUrl`), so tightening it to a Storage‑origin allowlist risks breaking URL signing/caching without runtime verification (unavailable in this environment). Recommended as a **fast‑follow** with a dedicated render‑layer test rather than a launch blocker.
- **M‑8 · `ExamQuestionsArchive.jsx:168`** — React list keys use `Math.random()`, forcing remount churn and losing element state/focus on every render. Use a stable key (question id/index).
  → **Resolved.** Key is now `${q.subject}-${idx}-${q.id || 'noid'}` (`ExamQuestionsArchive.jsx:168`) — stable across renders; `idx` already disambiguates within the filtered list. UI‑only change (no unit test; covered by the manual archive check in QA‑F3/rendering review).

### Low
- **L‑1** — README is effectively empty ("MockTest"); no `.env.example`; no documented run/build/test/migrate/bootstrap runbook. (Ops hygiene — §7 execution.)
- **L‑2** — No CI workflow to run `lint` + `node --test` on push, so regressions like B‑1/B‑2 aren't caught automatically.
- **L‑3** — Dead admin account‑provisioning UI path with a cleartext password field (server provisioning is the real path); remove to reduce confusion/attack surface.
- **L‑4** — `AdminAnalyticsCharts` lacks default props / empty‑data guards; verify it renders safely with zero results.
- **L‑5** — Secrets audit: confirm no service‑role key or `.env` is committed; confirm only `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (public anon key) reach the client bundle.

---

## 6. Positive controls — preserve, do not regress

These were confirmed working and are load‑bearing for exam integrity. Any change in §7 must keep them intact, and the test/QA suite should assert them:

1. **Answer keys never leave the server** — stripped on write, isolated in `cbt_exam_answers`, reconstructed only for AAL2 admins.
2. **Scoring is server‑side** and results are **immutable** (UNIQUE + revoked DML + trigger).
3. **`search_path` is pinned** on every `SECURITY DEFINER` function (no search‑path hijack).
4. **Admin writes require MFA/AAL2** (`is_admin_aal2()`), enforced in the DB, not just the UI.
5. **CSV formula injection is neutralised** (`resultExportLogic.js:120` prefixes `= + @ -` cells).
6. **KaTeX renders with `trust:false`** and HTML is escaped in `MathRenderer` — no math‑markup XSS.
7. **Offline recovery is ownership‑ and version‑checked** and rejects foreign/corrupt/stale records (`examLogic.js`).
8. **Passwords are intentionally not trimmed** (`AuthPortal.jsx:53,114`) — leading/trailing spaces are valid characters. Keep.

---

## 7. Phased execution plan (step‑by‑step)

Work proceeds **one step at a time**, verifying each before moving on. Steps are ordered by risk and dependency.

### Phase 0 — Freeze the baseline (no code change)
Confirm the finding set against source (done for blockers) and record the exact current line numbers so edits are precise. Produce the QA scenario catalogue (companion document `QA_SCENARIOS_AND_QA.md`) so every fix has a matching acceptance check.

### Phase 1 — Fix the crash (B‑1)
Move `activeTab`/`activeExamId` `useState` above the first `useEffect` in `AdminDashboard.jsx`. Re‑read the file to confirm no other hook references state declared later. Acceptance: admin dashboard mounts without `ReferenceError` (QA‑A1).

### Phase 2 — Fix leaderboard exports (B‑2)
Read the render scope around `:2060‑2100` to identify the authoritative total‑count state variable; correct both call sites; confirm `expectedCount` is an integer equal to the exam's total result count and the title is the exam title. Acceptance: CSV and PDF export succeed for 0, 1, one‑page (~100), and multi‑page (>500) cohorts (QA‑A2/A3).

### Phase 3 — Medium correctness/robustness fixes (M‑1 … M‑8)
Each finding was verified against source first, then given a disposition (recorded inline in §5). **Applied with unit tests** (pure logic): M‑1, M‑2, M‑3, M‑4, M‑6 — covered by `tests/stage20-medium-hardening.test.mjs`. **Applied as a UI‑only edit** (no unit test, manual/render check): M‑8. **Deferred with documented residual risk** (no code change — unreachable in production and/or already mitigated server‑side, and unverifiable here without a running app): M‑5, M‑7. Each applied fix is a self‑contained, reviewable edit; the two M‑6 files must be reviewed together (see §5). Because the test runner cannot execute in this environment, the new tests are authored and handed off with the command `node --test tests/*.test.mjs` — they have **not** been run/verified here.

### Phase 4 — Backend security migration (B‑3)  *(authored here, applied by you in staging first)*  → **Authored.**
Authored as `supabase/migrations/20260911000000_stage20_close_question_predisclosure.sql`. It closes direct `questions_data` access on `cbt_exams_raw` while preserving (a) the admin edit path, (b) the student dashboard, and (c) Realtime exam‑status updates that the student UI subscribes to on `cbt_exams_raw`. The fix has three coordinated parts in one transaction: a **column‑level SELECT grant** on `cbt_exams_raw` that excludes `questions_data`; a `SECURITY DEFINER` manifest function `public.exam_questions_for_viewer(uuid)` (Admin‑AAL2 → reconstructed paper; assigned non‑archived student → `questions_data` minus the `questions` key; else `NULL`; mirrors the `cbt_exams_read_assigned` predicate); and a redefinition of the `public.cbt_exams` view to source `questions_data` from that function (same 7 columns, so the `INSTEAD OF` admin‑write trigger stays attached). The manifest is required because the view is `security_invoker` — after the column revoke, a student can no longer read `r.questions_data` as themselves. Realtime keeps working because a column‑level grant still satisfies `has_table_privilege()` and Realtime drops columns the subscriber can't read; the two client Realtime handlers only read `status`/`class`/`section` off the payload. Ship with the **B‑3 validation checklist** (§10.4) and the full apply/validate/rollback runbook `docs/B3_MIGRATION_RUNBOOK.md`: apply to staging, run the PostgREST pre‑disclosure PoC as a student and assert `questions_data` is no longer returned, confirm dashboard/pre‑exam status/exam start/admin edit all still work, then promote to production. Includes an inline rollback block. **Authored but not executed here** (no DB/CLI access) — you run it against your own projects.

### Phase 5 — Test coverage expansion
Extend `node --test` coverage for the logic modules touched in Phases 2–3 and for untested edge cases in `examLogic.js`, `resultExportLogic.js`, `resultPaging.js`, `importLogic.js`, `numericalAnswerPolicy.js`, `runtimeDiagnostics.js`, `imageValidation.js`, and `examPreflightLogic.js` (see §8.1 for the matrix).

### Phase 6 — E2E specs (Playwright)
Author runnable Playwright specs + a seeding/fixtures harness covering the critical journeys and anti‑cheat/offline edge cases (§8.3). Authored here; you run them against a seeded staging instance.

### Phase 7 — Ops & docs hygiene (L‑1 … L‑5)
Write a real README + runbook, add `.env.example`, add a CI workflow (lint + `node --test`), remove the dead provisioning UI, and complete the secrets audit.

### Phase 8 — Verification & sign‑off
Run the full release gate (§10). Produce `PRODUCTION_READINESS_REPORT.md` summarising what changed, what was tested, residual risk, and the commands you must run locally to reproduce the green gate.

---

## 8. Testing strategy (all types)

### 8.1 Unit / logic tests (`node --test`)
Target the pure modules (no DOM). Priority additions, each with edge cases:
- **Scoring & export** (`resultExportLogic.js`): tie‑breaking ranks, `maxScore = 0` exclusion, duplicate student rejection, non‑ASCII PDF guard, formula‑injection prefixing, CSV BOM/line endings.
- **Result paging** (`resultPaging.js`): page boundaries, `expectedCount` mismatch detection, `finiteNumber` rejecting `null/''/false` (M‑2), subject‑set drift detection.
- **Offline recovery** (`examLogic.js`): foreign‑account rejection, corrupt JSON, schema‑version mismatch, version‑conflict reconciliation (local == server vs. drift), zero‑answer preservation, idempotent submission keys.
- **Import** (`importLogic.js`): `NAT → NUMERICAL` mapping (M‑3), malformed rows, option/answer validation.
- **Preflight** (`examPreflightLogic.js`): `null`/non‑object question entry (M‑1), empty subject, missing options.
- **Diagnostics/redaction** (`runtimeDiagnostics.js`): full bearer‑token redaction (M‑4), ReDoS input bounded.
- **Numeric answers** (`numericalAnswerPolicy.js`): tolerance/precision, sign, exponent forms, whitespace.
- **Runtime config** (`runtimeConfig.js`): placeholder/HTTP/short‑key rejection; capability probe fail paths.

### 8.2 Integration tests (DB / RPC) — run against a staging Supabase project
Exercise the RPC contracts and RLS as **student**, **admin (AAL1)**, **admin (AAL2)**, and **anon**: `claim_student_session`, `start_exam_session` (randomised paper, no answers), `sync_active_session_progress` (version conflicts), `submit_exam` (idempotency, grace period), `terminate_exam`, `record_result_export`. Assert answer keys are never returned to non‑admins, results are immutable, and — post‑fix — `cbt_exams_raw.questions_data` is unreadable by students.

### 8.3 End‑to‑end tests (Playwright) — authored here
Critical journeys: student login → single‑active‑session enforcement → pre‑exam gate → active exam → autosave → submit → result; admin login → **MFA/AAL2** → create exam → activate → view results → **export CSV/PDF** (guards B‑1/B‑2 in a browser). Anti‑cheat & resilience edge cases: fullscreen exit, tab blur/visibility, 3‑strike termination, refresh‑mid‑exam recovery, offline→online reconciliation, session hijack from a second device, timer expiry at the server grace boundary. Seeding/fixtures notes ship with the specs.

### 8.4 Security tests
RLS negative tests (cross‑student data access, pre‑start question fetch — the B‑3 PoC), answer‑key exfiltration attempts, CSV/formula injection, XSS via question/math content, storage‑object access control, admin‑without‑MFA rejection, JWT/session‑binding checks.

### 8.5 Performance / scale (analysis + load harness)
At 1,000 concurrent students the hot paths are `start_exam_session`, periodic `sync_active_session_progress` autosave, and Realtime fan‑out. Verify indexes exist for the assignment/lookup paths (`20260910060000` adds `cbt_exams_assignment_idx`), bound autosave frequency, and provide a k6/Artillery load‑test outline for the RPC endpoints. (Load execution is a deployment‑adjacent step; the harness and thresholds are delivered, execution is yours.)

### 8.6 Accessibility
Keyboard navigation and ARIA are already considered (`AuthPortal` tablist, `AccessibleModal`, `LiveAnnouncer`). Add an axe‑core pass in the E2E suite and manual screen‑reader checks on the login, pre‑exam, and active‑exam screens.

---

## 9. Explicitly out of scope (PRD‑only, not implemented)
Per the agreed scope, these appear in the stale PRD but **not** in the code and will **not** be built here — they are flagged for product decision only:
- **WebRTC webcam/live proctoring** — no camera/WebRTC code exists.
- **PDF.js question‑paper parsing** — no PDF parsing exists; question import is via the AI importer / structured input.
- **Firebase** — the PRD's backend; the real backend is Supabase. The PRD should be rewritten to match the implementation.

---

## 10. Release gate (definition of done)

### 10.1 Blockers
- [ ] B‑1 fixed; admin dashboard mounts cleanly.
- [ ] B‑2 fixed; CSV + PDF export verified across cohort sizes.
- [ ] B‑3 migration authored **and validated in staging** with the PoC now failing.

### 10.2 Quality bar (you run these locally — workspace can't here)
- [ ] `npm ci` clean install.
- [ ] `npm run lint` passes.
- [ ] `npm test` (`node --test tests/*.test.mjs`) green, including new tests.
- [ ] `npm run build` (`vite build`) succeeds with no new warnings.
- [ ] Playwright E2E green against seeded staging.

### 10.3 Hygiene
- [ ] README + runbook, `.env.example`, CI workflow present.
- [ ] Secrets audit clean (no service‑role key/`.env` committed; only public anon key in the client).

### 10.4 B‑3 staging validation checklist (must pass before prod)
Full command‑level procedure (apply, verify, security PoC, regression, rollback, promote) is in **`docs/B3_MIGRATION_RUNBOOK.md`**. Acceptance summary:

1. Apply `20260911000000_stage20_close_question_predisclosure.sql` to a **staging** Supabase project.
2. As a seeded **student** whose class/section matches a **PENDING** exam, call `GET /rest/v1/cbt_exams_raw?select=questions_data&id=eq.<examId>` with the student JWT → **must not** return the `questions` payload (PostgREST now denies the column). Also confirm `select=*` omits `questions_data` and the `exam_questions_for_viewer` RPC returns metadata only (no `questions` key).
3. Student dashboard still lists assigned exams; pre‑exam status still updates over Realtime; `start_exam_session` still delivers the randomised paper.
4. Admin (AAL2) can still create/edit exams and see reconstructed questions (with `correctAnswer`) for editing via the `cbt_exams` view.
5. Structural checks pass (`has_column_privilege` false for `questions_data`, true for safe columns; function is `SECURITY DEFINER` with pinned `search_path`; view has 7 columns and its `INSTEAD OF` trigger); existing `node --test` + integration tests still green.
6. Promote to production only after every step above passes on staging; re‑run the PoC (step 2) against prod to confirm.

---

## 11. Deliverables produced by this engagement
1. **`PRODUCTION_READINESS_PLAN.md`** (this document).
2. **`QA_SCENARIOS_AND_QA.md`** — scenario catalogue + production‑readiness Q&A used as acceptance checks.
3. Code fixes for B‑1, B‑2, and the medium findings (contained edits under `src/`).
4. A reviewed **B‑3 migration** (`supabase/migrations/20260911000000_stage20_close_question_predisclosure.sql`) + its apply/validate/rollback runbook **`B3_MIGRATION_RUNBOOK.md`** and the §10.4 staging checklist.
5. Expanded **`node --test`** logic tests under `tests/`.
6. **Playwright E2E** specs + seeding/fixtures notes.
7. Ops/docs: README + runbook, `.env.example`, CI workflow.
8. **`PRODUCTION_READINESS_REPORT.md`** — final sign‑off with residual risk and the commands to reproduce the green gate.
