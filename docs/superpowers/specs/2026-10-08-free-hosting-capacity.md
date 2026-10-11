# ExamForge: maximize reliable student capacity on free hosting

## Assessment

**Your plan is sound, but it needs tighter priorities and measurable limits.** Removing student Realtime is justified: Supabase Free currently allows 200 concurrent Realtime connections. That limit applies to WebSockets, not all students using HTTPS. [Supabase limits](https://supabase.com/docs/guides/realtime/limits)

Polling removes that particular ceiling, but database CPU, authentication bursts, bandwidth, and storage still determine capacity. Free currently includes shared CPU, 500 MB database storage, and 5 GB uncached egress. [Supabase pricing](https://supabase.com/pricing)

The objective should be: **find the largest reliably tested cohort, then retain operating headroom**, with no predetermined student count.

## Highest-priority changes

1. **Make dashboard reads genuinely bounded.**
   The current dashboard fetches all pages of exams and results and selects `questions_data`. Replace this with a server-filtered dashboard RPC returning 25 exam cards per page, their result/attempt summaries, and only required metadata. Load subsequent pages on demand; never download historical collections during every refresh.

2. **Use one polling owner per student screen.**
   Remove student subscriptions after their replacements work. Poll the dashboard’s visible page or the selected exam’s runtime state every randomized 20–30 seconds. Use completion-based scheduling, cancellation, backoff, and offline/visibility handling. Refresh immediately on reconnect or return. This interval is a normal-condition target; outages can delay updates.

3. **Avoid separate requests for overlapping runtime information.**
   Runtime responses should include server time, deadline, attempt status, session ownership, and access generation. Successful save responses should return equivalent runtime information, allowing the next status poll to be postponed. Preserve server-side validation on every protected action.

4. **Unify autosave and submission.**
   The current autosave already has a single-flight/latest-pending mechanism, but submission makes a separate save call. Route both through one pipeline. Freeze editing, flush the newest snapshot, then submit its confirmed version. Retry an uncertain save with the same payload and expected version; preserve existing conflict handling and idempotent submission.

5. **Reduce subject-time traffic.**
   Subject timing currently makes a separate request every 30 seconds. Add optional cumulative subject timing to the existing save RPC, preserving its server validation. Retain a changed-only timing request after 60 seconds without a successful combined save. Timing failures must not prevent grading already-confirmed answers.

6. **Keep strict deadline enforcement and honest recovery.**
   Anchor the countdown to server time using a monotonic browser clock. Shorten changed-answer debounce to 250 ms during the final 10 seconds while preserving single-flight saves. After expiry, grade only server-confirmed answers. Clearly label locally pending answers; never promise recovery of answers that did not reach the server.

## Database and operational changes

- Keep the existing session/version protections, grading, retries, and finalizer. Additive RPC changes must remain compatible with the previous frontend and scheduled finalizer.
- Review query plans with representative data. Verify indexes for ownership, assignments, pagination, and expired-session selection. One RPC can still execute expensive queries.
- Keep admin Realtime and existing refresh coalescing; refresh only visible collections. Measure database work as well as HTTP request count.
- Measure finalizer backlog and oldest pending deadline. Its current batch is 200 attempts per minute; test large abandonment bursts before changing that batch.
- Keep protected paper delivery and private media. Reduce image sizes and unnecessary preloading without exposing papers or answer keys through public caching.
- Stagger login before exam activation and test shared-school-IP authentication limits, token refresh, and reconnect bursts.
- Track projected monthly egress and database growth, including stored paper copies, results, indexes, and audit records. Preserve academic records; use verified operator backups rather than automatic deletion to reclaim space.

## Verification and rollout

- Establish a baseline, then increase concurrency progressively on disposable hosted **Free-tier staging** until a threshold fails. The repository’s documented 100-student local rehearsal does not establish hosted capacity.
- Update the existing harness to match actual polling, save, and timing behavior. Run a full exam duration, including JWT refresh, representative papers/media, admin activity, and simultaneous starts/submissions.
- Require zero lost confirmed answers, stale-device writes, duplicate results, or incorrect grades. Retain existing latency targets: autosave p95 ≤1 second, dashboard ≤2 seconds, start/submission ≤3 seconds, and unexpected request errors ≤1%.
- Test lost responses, refresh, offline recovery, takeover, re-grant, clock changes, expiry during retries, and finalizer backlog.
- Deploy additive backend changes, validate staging, deploy the frontend, and rehearse rollback before production.
- Publish an operating cohort limit at **70% of the highest repeatedly passing concurrency**. If demand exceeds it, split sittings.

## Chosen defaults

Strictly free hosting; 20–30-second student updates under normal conditions; existing React/Vite and Supabase architecture; no additional infrastructure. Capacity remains a measured result, not an architectural promise.
