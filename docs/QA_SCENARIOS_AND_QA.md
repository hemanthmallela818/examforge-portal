# CBT Examination Portal — QA Scenarios & Production‑Readiness Q&A

**Companion to:** `PRODUCTION_READINESS_PLAN.md`
**Purpose:** A concrete, executable catalogue of test scenarios (with edge cases) plus a production‑readiness question bank used as the acceptance gate. Each scenario states preconditions, steps, and the **expected** result. Scenarios tied to a known defect are marked with the blocker/finding ID (B‑1/B‑2/B‑3, M‑*, L‑*).

**Roles used:** `Student`, `Admin‑AAL1` (password only), `Admin‑AAL2` (password + verified TOTP), `Anon` (no session), `Attacker` (authenticated student using raw HTTP / devtools).

**Legend for status:** ☐ not yet run · ✅ pass · ❌ fail · ⚠️ pass with caveat.

---

## Part A — Admin dashboard & exports

### QA‑A1 — Admin dashboard mounts *(guards B‑1)*
- **Pre:** Admin‑AAL2 signs in.
- **Steps:** Land on the admin dashboard.
- **Expected:** Dashboard renders; **no** `ReferenceError: Cannot access 'activeExamId' before initialization` in console; tabs (Dashboard/Students/Classes/Question Bank) are interactive.
- **Edge:** Hard refresh on the dashboard; open with an empty exam list; open with 500+ exams (pagination).

### QA‑A2 — Leaderboard CSV export *(guards B‑2)*
- **Pre:** An exam with results exists.
- **Steps:** Open the exam detail → click "Download CSV".
- **Expected:** A `.csv` downloads with BOM, `\r\n` line endings, header row, one row per student, correct ranks; **no** "The result set changed while the export was being prepared." error.
- **Edge (must all pass):** 0 results (friendly "nothing to export"); 1 result; exactly one page (~100); **multi‑page (>500)** so the total‑count guard is exercised; a student name beginning with `=`/`+`/`@`/`-` is prefixed with `'` (formula‑injection neutralised); duplicate student id → rejected with a clear message.

### QA‑A3 — Leaderboard PDF export *(guards B‑2)*
- **Pre:** Same as A2.
- **Steps:** Click "Download PDF".
- **Expected:** PDF downloads, title = exam title, generated‑on line, striped table, page numbers.
- **Edge:** >2,000 results → blocked with "Download CSV for larger cohorts"; too many subject columns → blocked with the readable‑PDF message; a non‑ASCII (e.g. Unicode) name → blocked with the UTF‑8‑CSV message (font‑safety guard), not a broken glyph.

### QA‑A4 — Result count integrity during export
- **Steps:** Begin an export while a new result is being written server‑side.
- **Expected:** If the total changes mid‑export, the operation aborts with the *legitimate* "result set changed — retry" message and re‑fetches; it must not silently export a partial file. (This is the guard that B‑2 was falsely tripping.)

### QA‑A5 — Exam CRUD lifecycle
- **Steps:** Create exam (PENDING) → activate (ACTIVE) → end (ENDED).
- **Expected:** Only valid transitions allowed (PENDING→ACTIVE→ENDED; ENDED→ACTIVE only when no attempts); after any attempt exists, questions/class/section are immutable (server rejects with the lifecycle message).
- **Edge:** Attempt an illegal transition (e.g. PENDING→ENDED) → server rejects; edit questions after a student has started → rejected.

### QA‑A6 — Admin MFA enforcement
- **Steps:** Admin‑AAL1 signs in without TOTP.
- **Expected:** Cannot reach admin write operations; MFA enrolment/challenge is required; stale unverified TOTP factors are cleaned up before a new enrolment; cancelling enrolment unenrolls and signs out.
- **Edge:** Wrong TOTP code; expired challenge; cancel mid‑enrolment.

---

## Part B — Authentication & session

### QA‑B1 — Student login (happy path)
- **Steps:** Enter Student ID + password.
- **Expected:** ID is upper‑cased and mapped to `<id>@student.com` if no `@`; `claim_student_session` binds the JWT; dashboard loads.
- **Edge:** ID already an email; inactive roster entry → "account is inactive"; not a student → "not configured as an active student".

### QA‑B2 — Password whitespace is significant *(guards positive control)*
- **Steps:** Register/log in with a password that has a leading/trailing space.
- **Expected:** Password is **not** trimmed; the space is part of the credential. (Do not "fix" this.)

### QA‑B3 — Rate limiting
- **Steps:** Trigger repeated failed logins.
- **Expected:** On HTTP 429 / "rate limit" the UI shows "Too many sign‑in attempts…", not "Invalid credentials".

### QA‑B4 — Single active session
- **Pre:** Student logged in on device 1.
- **Steps:** Log in as the same student on device 2.
- **Expected:** Session is claimed by device 2; device 1 detects the hijack over Realtime and is locked out of exam operations.
- **Edge:** Two logins racing simultaneously → exactly one wins; the loser gets a clear message.

### QA‑B5 — Anon / unauthenticated access
- **Steps:** As Anon, hit app routes and REST endpoints.
- **Expected:** No exam, roster, question, or result data is returned; the runtime‑config guard blocks boot on a misconfigured/placeholder/HTTP Supabase URL.

---

## Part C — Exam taking (student)

### QA‑C1 — Pre‑exam gate
- **Steps:** Open an exam that is still PENDING.
- **Expected:** Instructions + browser/device compatibility check shown; **Start** is disabled until status is ACTIVE; status updates live (Realtime) and via the 15s poll.
- **Edge:** Incompatible browser (no `crypto.randomUUID`, blocked storage, no `fetch`, no `Promise.allSettled`) → "cannot safely start the exam" with the specific missing capabilities listed.

### QA‑C2 — Active exam & server‑authoritative timer
- **Steps:** Start the exam; observe the countdown.
- **Expected:** Time remaining derives from the server `endTime`, not client ticks; changing the local clock does not extend time; at expiry the exam auto‑submits within the server grace period (180s).
- **Edge:** Clock skew forward/backward; laptop sleep/resume; very short duration.

### QA‑C3 — Autosave with version concurrency
- **Steps:** Answer questions; observe periodic sync.
- **Expected:** Progress syncs with the `version` counter; a stale version is rejected and reconciled; exponential‑backoff retry on transient failure; no lost answers on flaky network.

### QA‑C4 — Server‑owned randomised paper & no answer key *(guards positive control + B‑3)*
- **Steps:** As Attacker, inspect every network payload during start/sync/submit; also call `start_exam_session` directly.
- **Expected:** The delivered paper contains **no** `correctAnswer` field anywhere; question order is server‑randomised; the client cannot influence scoring.

### QA‑C5 — Submission (idempotent)
- **Steps:** Submit; then retry submit (double‑click, network retry, reconnect flush).
- **Expected:** Exactly one result row is created; repeated submits are idempotent; the result is immutable afterwards.
- **Edge:** Submit at the grace boundary; submit after termination.

---

## Part D — Anti‑cheat

### QA‑D1 — Fullscreen enforcement
- **Expected:** Exiting fullscreen raises a warning; repeated violations count toward termination.

### QA‑D2 — Tab/window blur & visibility
- **Expected:** Switching tabs/apps or hiding the window is detected and warned; keyboard shortcuts for copy/switch are locked where feasible.

### QA‑D3 — 3‑strike termination
- **Steps:** Accumulate 3 violations.
- **Expected:** Exam terminates, a termination record is written (idempotently, with offline flush if needed), and the student sees the Terminated screen.
- **Edge:** Violations while offline → queued and flushed on reconnect; termination during submit.

### QA‑D4 — Context menu / keyboard lockdown
- **Expected:** Right‑click and blocked shortcuts are suppressed during ACTIVE; `beforeunload` warns on navigation away.

---

## Part E — Offline & resilience

### QA‑E1 — Refresh mid‑exam
- **Steps:** Refresh the browser during ACTIVE.
- **Expected:** Recovery record (schema‑versioned, ownership‑checked) restores responses/position; server remains authoritative; local overlays only when local version == server version.

### QA‑E2 — Offline → online reconciliation
- **Steps:** Go offline, answer, come back online.
- **Expected:** Local answers merge without clobbering newer server progress; version conflict → server wins and the user is informed; numeric `0` answers are preserved (not treated as empty).

### QA‑E3 — Foreign / corrupt / stale recovery record
- **Steps:** Plant a recovery record from another account, a corrupt JSON blob, and an old schema version.
- **Expected:** All three are rejected and discarded; only the rightful owner's current‑schema record is honoured.

### QA‑E4 — Storage unavailable / full
- **Expected:** App degrades gracefully (server enforcement still authoritative); compatibility check flags blocked/full storage before start.

---

## Part F — Question bank & reviewed JSON import

### QA‑F1 — Import type mapping *(guards M‑3)*
- **Steps:** Import questions including type `NAT`.
- **Expected:** `NAT` maps to internal `NUMERICAL`; numeric answers validated per `numericalAnswerPolicy` (tolerance, sign, exponent, whitespace).
- **Edge:** Malformed rows, missing options, MCQ with no correct answer → reported, not silently imported.

### QA‑F2 — Preflight robustness *(guards M‑1)*
- **Steps:** Preflight an exam whose question list contains a `null`/non‑object entry.
- **Expected:** The bad entry is reported as invalid; preflight does **not** crash and still validates the rest.

### QA‑F3 — Image handling *(guards M‑5, M‑7)*
- **Steps:** Add a question image from the Storage bucket; then attempt an off‑origin `https:` and a crafted `data:` URL.
- **Expected:** Storage image renders; off‑origin `https:` and crafted `data:` URLs are rejected **at authoring/activation** by `examPreflightLogic` and the DB `preflight_validate_exam` — this server‑authoritative preflight is the control that must hold.
- **Note (M‑5/M‑7 dispositions):** The client‑side `Image`‑capability branch in `imageValidation.js` is a **test‑only shim**, not a production security control (M‑5, deferred). `StorageImage` still renders any direct `https:`/`data:` URL without an origin allowlist (M‑7, deferred as a fast‑follow). Neither is a launch blocker *because* the authoring/activation preflight already blocks disallowed asset URLs before they can reach a student's screen — so this scenario's pass criterion is the server‑side rejection, and client image validation must **not** be relied on for security.

---

## Part G — Security (negative tests)

### QA‑G1 — Question pre‑disclosure *(the B‑3 proof‑of‑concept)*
- **Steps (Attacker):** With a student JWT for a class/section matching a **PENDING** exam, call `GET /rest/v1/cbt_exams_raw?select=questions_data&id=eq.<examId>`.
- **Expected (before fix): ❌** returns the full question list. **Expected (after fix): ✅** denied or `questions` stripped; the only way to obtain questions remains `start_exam_session` after a legitimate start.
- **Also verify:** the safe `cbt_exams` view still returns metadata (no `questions`) to students, and Realtime status updates still arrive.

### QA‑G2 — Cross‑student data access
- **Steps:** As student A, attempt to read student B's results/session/roster row via REST.
- **Expected:** RLS denies; only own rows are visible.

### QA‑G3 — Answer‑key exfiltration
- **Steps:** As student, attempt to read `cbt_exam_answers` and the admin reconstruction path.
- **Expected:** Denied; keys are only reconstructed for Admin‑AAL2.

### QA‑G4 — Injection & XSS
- **Steps:** Put `=cmd|…`, `"><script>`, and math `\href`/HTML into names, questions, and options; export and render.
- **Expected:** CSV cells with leading `= + @ -` are prefixed; rendered HTML is escaped; KaTeX runs with `trust:false`; no script executes.

### QA‑G5 — Diagnostics redaction *(guards M‑4)*
- **Steps:** Trigger a diagnostic that includes an Authorization header / bearer token; feed a hostile long token.
- **Expected:** The **entire** token is redacted (no trailing substring leak); redaction completes quickly (no ReDoS stall).

### QA‑G6 — Admin write without MFA
- **Steps:** Admin‑AAL1 attempts an exam insert/update directly via REST/RPC.
- **Expected:** Server rejects ("MFA/AAL2 required"), not just the UI.

### QA‑G7 — Secrets in client bundle *(guards L‑5)*
- **Steps:** Grep the built bundle and repo.
- **Expected:** Only `VITE_SUPABASE_URL` and the public anon key are present; no service‑role key, no committed `.env`.

---

## Part H — Accessibility, compatibility, performance

### QA‑H1 — Keyboard & screen reader
- **Expected:** Login role tabs follow the ARIA tablist pattern (arrow/Home/End); modals trap focus (`AccessibleModal`); live regions announce state (`LiveAnnouncer`); axe‑core shows no critical violations on login, pre‑exam, active exam.

### QA‑H2 — Browser/device matrix
- **Expected:** Works on the `SUPPORTED_ENVIRONMENTS` set (Chrome/Edge/Firefox 90+, Safari 15+, Android/iOS); narrow‑viewport layout is usable; unsupported browser is blocked pre‑exam.

### QA‑H3 — List stability *(guards M‑8)*
- **Steps:** Re‑render the questions archive.
- **Expected:** No remount churn or focus loss (stable keys, not `Math.random()`).

### QA‑H4 — Scale sanity (1,000 concurrent)
- **Expected:** Assignment/lookup queries are indexed; autosave frequency is bounded; a k6/Artillery outline exists for `start_exam_session` / `sync_active_session_progress`; Realtime fan‑out is understood. (Execution is deployment‑adjacent.)

---

## Part I — Production‑readiness Q&A (the go/no‑go bank)

Answer each **Yes/No + evidence**. Any **No** on a ⛔ question blocks launch.

**Correctness & stability**
1. ⛔ Does the admin dashboard mount without runtime error? *(QA‑A1 / B‑1)*
2. ⛔ Do CSV and PDF exports work across 0/1/one‑page/multi‑page cohorts? *(QA‑A2/A3 / B‑2)*
3. Do all `node --test` suites pass, including the new edge‑case tests? *(§8.1)*
4. Does `vite build` succeed with no new warnings, and does the app boot from the built bundle?

**Security & integrity**
5. ⛔ Is the question paper impossible for a student to obtain before start, including via direct REST to `cbt_exams_raw`? *(QA‑G1 / B‑3)*
6. ⛔ Are answer keys unreachable by non‑admins on every path? *(QA‑C4, QA‑G3)*
7. Is RLS proven with negative tests for cross‑student access? *(QA‑G2)*
8. Are admin writes server‑enforced to require MFA/AAL2? *(QA‑A6, QA‑G6)*
9. Are CSV formula injection and content XSS neutralised? *(QA‑G4)*
10. Is diagnostic redaction leak‑free and ReDoS‑free? *(QA‑G5 / M‑4)*
11. Is the secrets audit clean (only public anon key client‑side)? *(QA‑G7 / L‑5)*

**Reliability & exam fairness**
12. ⛔ Is the timer server‑authoritative and immune to client clock changes? *(QA‑C2)*
13. Is submission idempotent and the result immutable? *(QA‑C5)*
14. Does refresh/offline recovery restore state without clobbering newer server progress, preserving `0` answers? *(QA‑E1/E2)*
15. Are foreign/corrupt/stale recovery records rejected? *(QA‑E3)*
16. Does single‑active‑session enforcement + hijack detection work under a race? *(QA‑B4)*
17. Does anti‑cheat (fullscreen/blur/3‑strike) behave correctly, including offline queueing? *(QA‑D*)*

**Data & content**
18. Are imported `NAT` questions handled as numeric? *(QA‑F1 / M‑3)*
19. Does preflight survive malformed questions? *(QA‑F2 / M‑1)*
20. Are images restricted to trusted origins and fail‑closed? *(QA‑F3 / M‑5/M‑7)*

**Ops & docs**
21. Is there a README + runbook, `.env.example`, and CI running lint + tests? *(L‑1/L‑2)*
22. Is the stale PRD reconciled (Supabase, no WebRTC/PDF.js) or clearly marked non‑authoritative? *(§9)*
23. Is there a documented backup/restore and migration‑apply procedure for the Supabase project?
24. Is there a rollback plan for the B‑3 migration if staging validation fails?

**Accessibility & compatibility**
25. Do the core screens pass axe‑core and keyboard/screen‑reader checks? *(QA‑H1)*
26. Is the supported browser/device matrix validated and unsupported browsers blocked? *(QA‑H2)*

---

## Part J — Traceability (defect → scenario)
- **B‑1** → QA‑A1, Q1
- **B‑2** → QA‑A2, QA‑A3, QA‑A4, Q2
- **B‑3** → QA‑G1, Q5 (+ view/Realtime regression checks)
- **M‑1** → QA‑F2, Q19 · **M‑2** → QA‑A4 + result‑paging unit tests · **M‑3** → QA‑F1, Q18 · **M‑4** → QA‑G5, Q10 · **M‑5/M‑7** → QA‑F3, Q20 · **M‑6** → dialog‑hang unit test · **M‑8** → QA‑H3
- **L‑1/L‑2** → Q21 · **L‑3** → admin‑UI removal check · **L‑4** → zero‑result analytics render · **L‑5** → QA‑G7, Q11
