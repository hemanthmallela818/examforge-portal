# Exam-Day Capacity and Backend Hardening

This note explains how the examination backend behaves with 100–300 candidates writing at the same
time, what was changed to support that, and which hosted Supabase settings must match.

## How the exam hot path works

| Step | Call | Frequency per candidate | Notes |
|---|---|---|---|
| Sign in | Supabase Auth + `claim_student_session` | once | Newest login owns the attempt |
| Start / resume | `start_exam_session` | once | Server shuffles and stores the paper; the browser uploads nothing |
| Autosave | `sync_active_session_progress` | only when answers change, debounced 1 s | Version-checked; navigation-only changes stay local |
| Subject timing | `sync_exam_subject_time` | every 30 s, only when changed | |
| Takeover detection | Realtime on the candidate's own `students` row | 1 socket for the sitting | |
| Submit | final versioned autosave, then `submit_exam(…, expected_version_param)` | once, retried if transient | Server grades its stored snapshot; idempotent |
| Abandoned attempts | `pg_cron` job `examforge-finalize-expired-sessions` | every minute | Finalizes attempts 2 minutes past the deadline |

All locks are per candidate (an advisory lock on student + exam, then that candidate's session row).
No request locks a row shared by other candidates, so throughput grows with database CPU rather than
being limited by one hot row.

## Changes made for large sittings

**Correctness**
- `submit_exam` grades the server-confirmed snapshot whenever the browser supplies the version of its final
  save. A stale tab or old device can no longer overwrite newer answers, and the administrator's answer review
  always matches the grade.
- A device that was taken over and retries its submit receives the already-committed result instead of an error
  (this recovery had been lost in the Stage 24 wrapper rewrite).
- An autosave whose response was lost is recognised on retry instead of being shown as a conflict.

**Reliability**
- Expired attempts are finalized automatically by `pg_cron`. Finalization takes locks in the same order as
  candidate requests and never waits, so it cannot deadlock with a candidate submitting at the deadline, and one
  broken attempt no longer aborts the whole batch.
- The browser retries transient failures (network loss, HTTP 429/502/503/504, statement and lock timeouts,
  PostgREST connection errors) with capped full-jitter backoff. Business errors are never retried.
- Candidate requests use `lock_timeout = 5s` (plus Supabase's default `statement_timeout = 8s`) so a slow request
  fails fast and is retried instead of queueing.

**Load reduction**
- Starting an exam no longer uploads the full paper and responses (the server always ignored them).
- Navigation no longer triggers server saves; subject timing is sent every 30 s only when it changed.
- Each student's dashboard receives only its own result events (server-side Realtime filter), and fallback
  polling runs every 30–45 s with per-browser jitter instead of every 15 s in lockstep.
- Student sign-in retries a rate-limited attempt with backoff before showing an error.

**Security and audit**
- Clearing the whole question bank is enforced as root-developer-only in the database.
- Student passwords are shown once after creation or reset and are never stored in the browser.
- Password resets are audited (without the password) and refused for archived students.
- Every Edge Function error returns a correlation ID (also in the `X-Correlation-Id` header and the function log),
  and the app shows it as "Reference: …".

## Hosted Supabase settings to apply before exam day

| Setting | Where | Recommended value | Why |
|---|---|---|---|
| Sign-in rate limit per IP | Authentication → Rate Limits | ≥ 2 × the largest sitting (e.g. 600 / 5 min) | A whole hall shares one school IP |
| Token refresh rate limit per IP | Authentication → Rate Limits | ≥ 6 × the largest sitting (e.g. 1800 / 5 min) | Every candidate refreshes about once an hour |
| `pg_cron` extension | Database → Extensions | enabled | Automatic finalization (the migration schedules the job) |
| Realtime concurrent connections | Plan / Realtime settings | above the sitting size plus admins | One connection per candidate |
| Compute size | Project → Compute | Small or larger for 300 candidates | Every autosave parses the candidate's paper copy |
| Point-in-time recovery | Database → Backups | enabled | Restore to any moment of an exam window |

## Verifying capacity

Run the load rehearsal against a disposable environment (never production). See `docs/LOAD_TESTING.md` for the
options and thresholds. Record p50/p95/p99 for sign-in, start, autosave, subject timing and submit, the error
breakdown, and confirm exactly one result per candidate with no leftover active sessions.

### Measured on the local Supabase stack (24 September 2026)

100 candidates, all acting at once, 120 s soak, sign-ins not staggered (worst case):

| Operation | Requests | Errors | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| Sign-in (attempts) | 129 | 29 × HTTP 500, all retried successfully | 1,589 | 2,183 | 2,613 |
| Session claim | 100 | 0 | 387 | 1,025 | 1,055 |
| Start rush | 100 | 0 | 142 | 305 | 333 |
| Autosave | 1,020 | 2 transient network, retried | 14 | 86 | 177 |
| Subject timing | 400 | 0 | 50 | 263 | 428 |
| Final sync (deadline rush) | 100 | 0 | 147 | 421 | 603 |
| Submit (deadline rush) | 100 | 0 | 114 | 330 | 407 |
| Submit retry (idempotent) | 100 | 0 | 122 | 150 | 169 |

All 100 candidates completed; every score matched; exactly one result each; no leftover sessions;
103/103 Realtime subscriptions confirmed; 3/3 takeovers detected; 10/10 stale-tab writes rejected.

**The only weak point is the sign-in burst.** When every candidate presses Login in the same second, the auth
server briefly returns HTTP 500. The login screen now retries these automatically, so candidates get in, but on
exam day stagger entry (for example by row) or open the hall a few minutes early.

**300 candidates could not be validated on a single laptop.** The local stack is not sized for it: Postgres allows
100 connections and the local auth server opens unpooled connections ("failed to connect … server error"), and the
local API gateway runs one worker limited to 512 connections ("worker_connections are not enough"). Hosted Supabase
uses a scaled gateway, pooled auth connections and compute-sized connection limits, so run the 300-candidate
rehearsal against a disposable hosted staging project:

```text
REHEARSAL_CONFIRM_DISPOSABLE=YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL \
REHEARSAL_CANDIDATE_COUNT=300 REHEARSAL_SOAK_SECONDS=300 npm run test:rehearsal:staging
```
