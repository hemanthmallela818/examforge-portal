# Load rehearsal (100–300 concurrent candidates)

`scripts/rehearse-staging.mjs` is the candidate load harness. `npm run test:rehearsal:local`
(`scripts/rehearse-local.mjs`) runs it against the local Supabase stack, and
`npm run test:rehearsal:staging` (`scripts/rehearse-connected-staging.mjs`) runs it against the
disposable staging project. Both wrappers pass every `REHEARSAL_*` variable through.

## What one run does

Every candidate has its own Supabase client, JWT and Realtime socket, and follows the real
client hot path (`AuthPortal.jsx`, `StudentDashboard.jsx`, `App.jsx`):

1. **Login and claim**: `signInWithPassword` and then `claim_student_session`. Sign-ins are
   paced by `REHEARSAL_AUTH_SIGNIN_DELAY_MS` (default 3000; the local wrapper sets 0), and a 429
   response is retried with backoff.
2. **Realtime and dashboard**: each candidate subscribes to the same `postgres_changes` UPDATE
   listener on its own `students` row that App.jsx uses for takeover detection. It then does the
   dashboard reads (`student_results`, `cbt_exams`), reads the paper (and checks that the answer
   key is hidden), and does the `active_sessions` restore read.
3. **Start rush**: every candidate calls `start_exam_session` at the same moment
   (`REHEARSAL_RUSH_LEAD_MS` after the barrier is armed), followed by the first versioned autosave.
4. **Takeover probes** (`REHEARSAL_TAKEOVER_PROBES`): a second device signs in mid-exam. The
   original device's listener must see the takeover, and its next autosave must be rejected by
   the server.
5. **Soak** (`REHEARSAL_SOAK_SECONDS`), for each candidate:
   - An autosave every 5–20 s with jitter. Each one changes 1–2 answers and sends the whole
     response object with `expected_version_param`, tracking the returned version. Network errors
     get the same retry and backoff as App.jsx.
   - A `sync_exam_subject_time` call about every 15 s (App.jsx uses a fixed 15 s interval). The
     subject time is cumulative, never goes backwards and never exceeds the elapsed time.
   - A light dashboard read every 30–60 s.
   - **Stale-tab probes** (`REHEARSAL_STALE_TAB_PERCENT`): an autosave with an old version must
     return `conflict` together with the unchanged server answers.
6. The existing security checks: cross-account reads, forged writes, and student and admin
   provisioning.
7. **Deadline rush**: every candidate runs `calculateResults` at the same moment: a final
   versioned sync, then subject time, then `submit_exam(exam_id_param, responses_param)`. That
   call works with and without the optional `expected_version_param`.
8. **Lost-response retry rush**: every candidate repeats the submit. The final sync must report
   the session as already submitted, and `submit_exam` must return the same committed score.
9. **Verification**: exactly one `student_results` row per candidate with the exact expected
   score, and zero `active_sessions` left for the exam.

## Output

- A progress line for each phase, a latency table (n, errors, p50/p95/p99/max, ops/s, the p95
  limit, and the top HTTP statuses for each operation), Realtime and stale-tab counters, and any
  thresholds that failed.
- A JSON report written to `REHEARSAL_REPORT_PATH`, by default `logs/load-rehearsal/<run>.json`
  (git-ignored). The same JSON is printed as the last stdout line.
  - `load.operations` lists each operation's latency percentiles, throughput and status counts,
    plus `errorKinds`: `rate_limited_429`, `server_5xx`, `postgrest`, `statement_timeout`,
    `serialization_or_deadlock`, `too_many_connections`, `version_conflict`, `network`,
    `rpc_exception` and `realtime_*`.
  - Designed rejections, such as a stale device or a retry after a commit, are counted as
    `expectedErrors`, not as errors.
- The run exits with status 1 if a correctness check fails or a threshold is exceeded.
- No keys, tokens or email addresses are printed or written. Error text is redacted.

## Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `REHEARSAL_CANDIDATE_COUNT` | 80 | Number of candidates (1–1000) |
| `REHEARSAL_CONCURRENCY` | candidate count | Worker pool size for the rush phases (max 1000). A value below the count models staggered arrival. |
| `REHEARSAL_AUTH_SIGNIN_DELAY_MS` | 3000 (local: 0) | Global spacing between sign-in starts |
| `REHEARSAL_PROVISION_CONCURRENCY` | 4 | Parallel service-role user creation |
| `REHEARSAL_SOAK_SECONDS` | 60 | Soak length (0 skips it; max 3000, which stays under the JWT expiry) |
| `REHEARSAL_AUTOSAVE_MIN_MS` / `_MAX_MS` | 5000 / 20000 | Autosave interval |
| `REHEARSAL_SUBJECT_TIME_MIN_MS` / `_MAX_MS` | 12000 / 18000 | Subject-time sync interval |
| `REHEARSAL_DASHBOARD_READ_MIN_MS` / `_MAX_MS` | 30000 / 60000 | Dashboard read interval during the soak |
| `REHEARSAL_STALE_TAB_PERCENT` | 10 | Share of candidates that send one stale-version autosave |
| `REHEARSAL_TAKEOVER_PROBES` | min(3, count) | Number of mid-exam device takeovers. Each costs one extra sign-in. |
| `REHEARSAL_RUSH_LEAD_MS` | 1000 | Barrier lead time for the start, deadline and retry rushes |
| `REHEARSAL_REALTIME_TIMEOUT_MS` | 15000 | Timeout for subscribing and for takeover detection |
| `REHEARSAL_REPORT_PATH` | `logs/load-rehearsal/<run>.json` | Where the JSON report is written |
| `REHEARSAL_THRESHOLDS` | see below | JSON overrides, for example `{"p95Ms":{"autosave":800},"maxErrorRate":0.02}` |
| `REHEARSAL_MAX_P95_AUTOSAVE_MS` | 1000 | Shorthand for the autosave p95 limit |
| `REHEARSAL_MAX_ERROR_RATE` | 0.01 | Maximum error rate for each operation |
| `REHEARSAL_MIN_REALTIME_SUBSCRIBE_RATE` | 1 | Minimum Realtime subscribe rate and `postgres_changes` binding rate |
| `REHEARSAL_ENFORCE_THRESHOLDS` | 1 | Set to `0` to report threshold results without failing the run. Correctness checks still fail it. |

Default p95 limits in ms:

| Operation | p95 limit (ms) |
| --- | --- |
| login | 3000 |
| claim | 1500 |
| realtime_subscribe | 5000 |
| dashboard_read | 2000 |
| start | 3000 |
| autosave | 1000 |
| subject_time | 1000 |
| final_sync | 2000 |
| submit | 3000 |
| submit_retry | 3000 |

These checks must also pass:

- zero unexpected takeover signals
- every takeover probe detected
- zero stale-device writes accepted
- zero stale-tab overwrites

## Running 100 and 300 candidates

Local stack, which must already be running. The wrapper registers a disposable admin under the
existing application owner and never replaces the owner:

```sh
REHEARSAL_CANDIDATE_COUNT=100 REHEARSAL_SOAK_SECONDS=300 npm run test:rehearsal:local
REHEARSAL_CANDIDATE_COUNT=300 REHEARSAL_SOAK_SECONDS=600 npm run test:rehearsal:local
```

Disposable staging:

- Pace sign-ins to the Auth rate limit. For example, 300 sign-ins with a 3000 ms delay is about
  15 minutes of login phase.
- Reset the project from its baseline afterwards, because results are immutable.

```sh
REHEARSAL_CONFIRM_DISPOSABLE=YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL \
REHEARSAL_CANDIDATE_COUNT=300 REHEARSAL_SOAK_SECONDS=300 REHEARSAL_AUTH_SIGNIN_DELAY_MS=3000 \
  npm run test:rehearsal:staging
```

Notes:

- **Realtime connections**: every candidate holds one Realtime connection. Check the project's
  Realtime concurrent-connection quota before a 300-candidate staging run (the Free plan allows
  200). A shortfall shows up as `realtime_*` error kinds and a subscribe rate below 1.
- **Sign-in pacing**: the login phase is paced, but the start and deadline rushes are not. They
  measure the database under a true simultaneous burst.
- **Wrapper timeout**: the wrapper timeout is 20 minutes plus the soak length. For example, a
  paced login of 300 × 3 s is about 15 minutes. Lower `REHEARSAL_AUTH_SIGNIN_DELAY_MS` only if
  the staging Auth rate limit has been raised to match.
- **Soak length**: the earliest student JWT must stay valid (1 h by default) until the retry
  rush. That limit covers the login phase plus the soak.
