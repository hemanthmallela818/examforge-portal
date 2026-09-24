# Final Deployment Audit — 24 September 2026
## Verdict

**Local release candidate: PASS. Production deployment: CONDITIONAL.**

The application passed the complete local release gate after the defects listed below were corrected. The code, database migrations, authentication boundaries, browser flows, offline recovery, termination handling, backup/restore proofs, and an 80-candidate rehearsal were exercised locally. Production should proceed only after the hosted-environment checklist at the end of this report is completed against the exact commit to be deployed.

## Final evidence

- Lint: **PASS**, zero warnings.
- TypeScript check: **PASS**.
- Unit, database-contract, security, accessibility, offline, and operational tests: **255/255 PASS**.
- Coverage: **96.97% lines**, **80.84% branches**, **97.64% functions**.
- Browser end-to-end suite: **42/42 PASS** on Chromium, Firefox, and WebKit, from a clean local database.
- Previously affected browser matrix: **24/24 PASS** across all three engines after the Edge runtime lifecycle correction.
- Production build: **PASS**, 728 modules transformed in 8.60 seconds.
- Largest production JavaScript chunk: `jspdf.es.min`, **399.67 kB** raw / **129.76 kB** gzip; no Vite size warning.
- Dependency audit: **0 vulnerabilities** at high-or-greater audit level (and 0 total reported).
- PostgreSQL/Supabase schema lint: **PASS**, no warnings.
- Clean migration replay: **PASS**, including `20260923175028_fix_optional_legacy_cleanup_lint.sql`.
- Operational health check: **HEALTHY**, no identified issues.
- Database restore proof: **PASS**, critical row counts and digests matched; no unvalidated public constraints.
- Private storage restore proof: **PASS**, 68-byte object hash matched, anonymous read remained blocked, signed read succeeded.

## 80-candidate rehearsal

The local rehearsal created and authenticated 80 independent candidates, established Realtime subscriptions, started 80 sessions, autosaved 80 answer sets, submitted 80 results, and retried all 80 submissions idempotently.

Outcomes:

- Authenticated students: **80/80**
- Session claims: **80/80**
- Realtime subscriptions: **80/80**
- Exam starts: **80/80**
- Autosaves: **80/80**
- Submitted results: **80/80**
- Idempotent submission retries: **80/80**
- Lost or cross-account answers: **0**
- Duplicate results: **0**
- Unhandled server errors: **0**
- Unauthorized student/result/exam writes: **blocked**
- Cross-account sessions/results: **hidden**
- Total rehearsal duration: **10,078 ms**

Latency in milliseconds:

| Operation | p50 | p95 | p99 / max |
| --- | ---: | ---: | ---: |
| Start session | 42.8 | 73.2 | 78.4 |
| Autosave | 38.8 | 70.6 | 106.6 |
| Submit | 48.5 | 147.7 | 194.5 |
| Idempotent retry | 31.8 | 51.9 | 62.6 |
| Realtime subscription | 220.6 | 231.5 | 235.4 |

These are local-machine measurements, not an Internet latency or hosted capacity guarantee.

## Feature and failure-simulation coverage

The automated suites cover:

- Student and administrator authentication, root ownership, managed administrator creation/disable, MFA/AAL2 authorization, and session takeover.
- Student roster, classes, Question Bank, strict reviewed-JSON import, exam assembly, lifecycle transitions, operational health, audit views, database cleanup controls, and CSV/PDF exports.
- MCQ and numerical questions, server-owned answer keys and scoring, negative marking, rank ties, result immutability, and idempotent submission.
- Pre-start question confidentiality, private image storage, expiring signed URLs, MIME/magic-byte validation, image dimension limits, required-media preflight, and unreferenced-storage cleanup.
- Reload/resume, optimistic autosave conflict handling, browser storage corruption/quota denial, offline answering, reconnect synchronization, pending submission isolation, tab suspension timer catch-up, deadline enforcement, and offline proctoring termination persistence.
- Lost HTTP response after a committed submission, injected 401/403/409/429/500 responses, explicit retries, Realtime outage with REST fallback, single-device takeover, double submission, and expired-session finalization.
- Keyboard/dialog semantics, status announcements, high-contrast CSS, mobile-width restrictions, screen-reader labels, and Chromium/Firefox/WebKit behavior.
- RLS and explicit grants, direct-write bypass denial, server-owned lifecycle RPCs, audit logging without answer content, bounded payloads, fixed search paths, paging limits, and formula-safe exports.

## Defects found and fixed

1. **Committed submission response loss could block recovery.** The retry attempted session-only writes after the first submission had already deleted the active session. The client now recognizes that unknown-outcome state and proceeds to the idempotent `submit_exam` RPC, which returns the already committed immutable result.
2. **Root administrator creation used the ordinary administrator AAL2 gate.** `create-admin` is now governed by the root-owner authority path, while ordinary administrator actions retain AAL2 enforcement.
3. **Local Edge Function CORS rejected the browser test origin.** Exact local origins are configured; hosted environments must set their exact HTTPS origin separately.
4. **Clean database reset silently removed the local Edge runtime.** The local E2E runner now performs start → reset → runtime recreation → function readiness → Playwright, preventing false DNS failures and ensuring root actions are actually tested.
5. **Edge Function failures hid the useful safe server response.** Root administration now extracts and displays the bounded JSON error returned by the function.
6. **Password reveal controls collided with Password/Login accessibility locators.** Both controls now have explicit secret-specific accessible names, `aria-controls`, and pressed state.
7. **WebKit multi-context takeover could exceed the global 60-second test budget on Windows.** That intentionally heavy scenario has a scoped 90-second budget; its assertions remain bounded and it passed.
8. **Confirmed dead code.** An unused PRD helper and a useless test-runner assignment were removed. No speculative bulk deletion was performed.

## Security review

- Browser configuration contains only the Supabase publishable key; privileged service credentials remain server-side.
- Candidate-facing exam data and Realtime publication exclude answer keys before submission.
- RLS, grants, server-owned RPCs, immutable results, account provisioning, session ownership, root-only destructive actions, audit records, and private storage are covered by executable contracts.
- The Edge Function validates exact origins, method, content type, payload size, authentication, role/owner authority, and safe action-specific input.
- CSV formula injection, unsafe filenames, malformed imports, duplicate rows, oversized inputs, invalid answer values, and cross-account browser recovery are rejected.
- `npm audit --audit-level=high` reported zero vulnerabilities.

Supabase local secret configuration follows the current official environment-variable guidance: [Supabase Edge Function environment variables](https://supabase.com/docs/guides/functions/secrets).

## Performance review

- The 80-candidate local run completed in about 10.1 seconds with sub-200 ms p99/max start, autosave, submit, and retry calls; Realtime subscription max was 235.4 ms.
- Large administrator collections use bounded server pagination instead of unbounded browser fetches.
- Analytics and heavy PDF/export code are split into lazy production chunks.
- The production build emitted no chunk-size warning. The heaviest optional dependencies are PDF and analytics modules, not the initial HTML shell.
- These numbers do not replace a hosted staging rehearsal from the target school network and representative student devices.

## Hosted deployment gates still required

Complete these against the exact release commit before calling production fully approved:

1. Run the full CI workflow on a clean hosted Linux runner.
2. Apply all migrations to disposable staging, deploy `manage-student`, and run the connected staging rehearsal with **80 candidates**.
3. Set production Edge Function secrets, especially `ALLOWED_ORIGINS`, to the exact HTTPS application origin; never copy local origins to production.
4. Confirm production Supabase Auth settings, root owner, managed administrators, MFA recovery process, leaked-password protection, rate limits, and email behavior.
5. Run Supabase database/security/performance advisors and the operational health check against staging and production.
6. Verify hosting headers: CSP, HSTS, `X-Content-Type-Options`, frame protection, Referrer-Policy, Permissions-Policy, and appropriate cache rules.
7. Exercise real Wi-Fi interruption, browser termination/restart, device takeover, clock drift, and reconnect from representative Windows/macOS/mobile devices.
8. Confirm monitoring, alerting, operator ownership, log retention, incident response, and exam-day escalation contacts.
9. Verify PITR/backups and perform a hosted database plus private-storage restore drill.
10. Perform a manual accessibility pass with keyboard-only navigation and at least one screen reader.

## Deployment recommendation

Do **not** deploy directly to production solely from this local result. Deploy this release candidate to disposable staging, complete the ten hosted gates above, and promote the same immutable commit only if they pass. No remaining local P0 product defect was found in the tested scope.
