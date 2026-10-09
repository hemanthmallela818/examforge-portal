# Exam-day capacity on free hosting

The operating cohort is currently **unmeasured on hosted Free tier**. Publish a cohort only after
three repeatedly passing representative full-duration hosted runs, then use
`floor(70% × highest repeatedly passing concurrency)`. Split sittings above that limit. Keep
React/Vite and Supabase Free; no paid compute or recovery feature is required by this plan.

## Current student traffic

| Action | Call | Behavior |
| --- | --- | --- |
| Login | Auth + `claim_student_session` | Newest claimed Auth session owns the attempt; stagger entry |
| Dashboard | `student_dashboard_page(page_param)` | 25 metadata cards plus summaries; only visible page every 20–30 s |
| Start/resume | `start_exam_session` | Stored server paper; no paper upload; includes runtime fields |
| Runtime | `student_exam_runtime` | One completion-scheduled 20–30 s poll; backoff, reconnect refresh |
| Save | `sync_active_session_progress` | Changed answers; version/generation checks; postpones runtime poll |
| Timing | Optional fifth save parameter | Cumulative timing piggyback; changed-only 60 s fallback after last success |
| Deadline | Confirmed answer snapshot | Server time anchors a monotonic countdown; final-ten-second debounce 250 ms |
| Submit | Flush save pipeline, then `submit_exam` | Freeze editing; submit confirmed version; grading and retries idempotent |
| Abandonment | Existing scheduled finalizer | Minute ticks, batch 200, existing two-minute grace |

Students use HTTPS polling and no Realtime socket. Admin Realtime and coalesced visible reads remain.
Successful saves already return ownership, server time, deadline, version and access generation.
Protected paper and private images stay on demand; metadata responses contain no questions or keys.
An invalid timing payload must preserve valid confirmed answers and cannot block grading.

## Evidence required before a sitting

Use [LOAD_TESTING.md](LOAD_TESTING.md) for the reproducible harness, controls and report gates.
Require dashboard p95 ≤2 s, answer-save p95 ≤1 s, start/submission p95 ≤3 s, and unexpected request
errors ≤1% per operation. There must be zero incorrect grades, lost confirmed answers, duplicate
results, stale-device/generation writes or cross-account data. Retries do not erase request failures.

Run the complete intended exam duration, including JWT refresh. Match real paper sizes, private
image bytes/views, retained exam/result/audit history and admin activity. Test simultaneous starts
and submissions, staggered hall login, one-school-IP Auth/refresh limits and reconnect bursts.
Keep existing Auth protection; confirm actual project limits before selecting pacing. Browser drills
must cover lost responses, offline/return, hidden screens, takeover, re-grant, expiry during retries,
clock changes and locally pending answers. An unsaved local answer is not a confirmed answer.

Watch expired-attempt backlog, **oldest pending deadline**, scheduler last run/failures and measured
drain rate through a large abandonment burst. Pending count includes the two-minute grace. With
200 attempts per tick, several ticks can be normal; a growing oldest age or unhealthy scheduler is
not. Verify the scheduled job is enabled on the hosted Free project; do not increase its batch just
to hide a failing capacity run.

Budget projected monthly egress and retained database growth against the project's current Free
allowances. Record actual dashboard egress plus relation/index sizes, paper copies, results and audit
records. Harness JSON response bytes omit protocol/Realtime overhead and database page growth can
understate newly stored rows. Leave headroom for non-exam usage. Preserve academic records and use
verified operator backups; automatic deletion is not a capacity strategy.

## Query-plan review with representative data

Seed disposable staging with the expected number of historical exams, students, results, access grants
and sessions, including class/section skew, global assignments and late dashboard pages. Run `ANALYZE`
after seeding. Run `EXPLAIN (ANALYZE, BUFFERS)` only on read queries in this disposable environment;
never run candidate write RPCs merely to obtain a plan on production.

An `EXPLAIN SELECT student_dashboard_page(...)` function node alone hides internal queries. Inspect
`pg_get_functiondef('public.student_dashboard_page(integer)'::regprocedure)` and explain its internal
CTEs using one representative student's class, section, Auth UUID and student ID. Confirm 26 metadata
rows fetched before 25 paper-metadata/result/session joins, no historical result collection scan,
stable `created_at DESC, id` order and acceptable late-page offset cost. Capture buffer counts and
execution time for small and heavily populated assignments; choose indexes from measured plans.

Inspect existing indexes first:

```sql
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('students', 'cbt_exams_raw', 'active_sessions', 'student_results', 'exam_access_grants')
ORDER BY tablename, indexname;

SELECT relname, pg_total_relation_size(oid) AS bytes
FROM pg_class WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('cbt_exams_raw', 'active_sessions', 'student_results', 'admin_audit_events');

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM public.active_sessions
WHERE deadline_at <= clock_timestamp() - interval '120 seconds'
ORDER BY deadline_at LIMIT 200;
```

Check current-session lookup by student Auth UUID, dashboard assignment/order lookup, unique
student/exam result lookup, session primary ID lookup, generation/grant lookup and deadline selection.
Inspect the actual finalizer definition too: explain its exact eligible predicate and ordering, including
its lock behavior, rather than assuming the simplified diagnostic above is its complete plan. A small
empty-table sequential scan is harmless; a representative large scan needs evidence. Add an index
only if the measured query plan warrants it. The reduced HTTP count alone does not prove reduced CPU.

## Additive deployment, backups and rollback

1. Before production changes, export the database and private storage separately, verify hashes/row
   counts and restore both into an isolated environment. Keep secure copies off the project. Free
   hosting does not require paid point-in-time recovery; preserve academic records and audit history.
2. Apply additive backend migration first in staging. Replay migrations and test old four-argument
   answer-save callers, the existing finalizer, new bounded/runtime RPCs, grading, ownership and timing
   rejection. Verify scheduler availability and representative plans.
3. Complete the repeated hosted Free rehearsals and browser drills. Record the operating cohort,
   current quotas, retained usage projections and backup/restore evidence before scheduling a sitting.
4. Deploy backend changes first, validate the old frontend against them, then deploy the frontend.
   Smoke-test each new RPC as a student and administrator, monitor errors/backlog/usage, and keep the
   previous frontend artifact available.
5. Rehearse restoring the previous frontend artifact while leaving the compatible backend migration
   installed. Do not drop new signatures or restore over academic results during a sitting. A backend
   rollback requires a reviewed forward repair or verified isolated restore procedure, not a hosted reset.

No production deployment, hosted capacity run or reset was performed for this implementation.

## Current local implementation evidence (8 October 2026)

The updated harness passed with five candidates and a measured 60,001 ms soak on an isolated local
Supabase stack: five expected grades, five identical submission retries, zero lost/cross-account
confirmed answers, zero duplicates and five token refreshes. Dashboard/save/start/submit p95 were
7.3/12.2/26.5/22.3 ms, with zero unexpected request errors. Runtime takeover detected 3/3 replacements
and the stale-tab conflict probe prevented an overwrite. The operating cohort remains unmeasured:
this short laptop run did not exercise hosted resources, representative media or a large abandonment burst.

## Historical local evidence (24 September 2026)

This used the previous Realtime/subject-time implementation on a laptop. It validates that historical
run only; it does not measure the current polling workload or hosted Free capacity.

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
