# Free-tier capacity rehearsal

No hosted operating cohort has been established by this change. Local checks validate behavior;
only repeated runs on the actual disposable hosted **Free** project establish capacity. Keep the
same code, Auth limits, data scale and representative paper/media as the intended sitting.

`scripts/rehearse-staging.mjs` is the harness. `npm run test:rehearsal:local` uses local Supabase;
`npm run test:rehearsal:staging` uses the explicitly disposable connected staging project. Both
wrappers pass `REHEARSAL_*` settings through and supply a temporary verified administrator.
Never run against production. Preserve JSON reports before an operator resets disposable staging:
immutable results and private media remain after the run; the harness does not reset the project.

## Workload and correctness gates

Each candidate has a separate Auth session and HTTPS client, with **no student Realtime socket**.
One administrator retains Realtime on the active sessions and reads up to 25 visible sessions
plus operational health every 30 seconds, without overlapping admin refreshes.

1. Password sign-ins share the harness's source IP. Sign-in starts are paced (default 3 seconds)
   and rate-limit/server failures are retried with backoff. Record every attempt, including retries.
2. The visible dashboard page is `student_dashboard_page(0)`, limited to 25 metadata cards. It is
   refreshed after a completion-scheduled randomized 20–30 seconds before starting. The harness
   rejects paper/answer-key fields in the dashboard response.
3. A barrier releases simultaneous `start_exam_session` calls. The start payload contains no
   paper. Candidates read `student_exam_runtime`, then send versioned confirmed-answer saves.
4. During the soak, answers change every 5–20 seconds. Saves include cumulative subject time;
   `timing_saved` alone confirms timing, and each successful answer save postpones the runtime
   poll. Runtime reads schedule from completion, with 20–30-second jitter and capped backoff.
   Changed timing gets a separate fallback only after 60 seconds without a successful timing
   save. Timing rejection never prevents submission of confirmed answers.
5. Takeover probes claim a second device, require the original runtime read to detect lost
   ownership, and require its stale save to fail. Stale tabs must return a version conflict and
   unchanged confirmed answers. Token refresh runs before expiry throughout login and soak.
6. A shared-IP burst explicitly refreshes every candidate token and immediately reads runtime,
   modeling the read path on reconnect. Each candidate also repeats a save with its original
   expected version as though the first response was lost; the confirmed version must stay fixed.
7. The existing cross-account, forged-write and provisioning checks remain. A submission barrier
   flushes the final answer/timing snapshot through the same serial save path, then submits its
   confirmed version. Submission retries must return the identical committed grade.
8. Exactly one result per candidate must match its unique expected grade, with no active sessions
   remaining. Optional abandonment probes start another one-minute paper, save confirmed answers,
   stop candidate traffic and wait up to `4 + ceil(probes / 200)` minutes for the scheduled finalizer; each grade and
   result count must match. The harness never invokes finalization to hide scheduler failure.

Optional `REHEARSAL_MEDIA_FILE` uploads one private PNG/JPEG/WebP (at most 5 MiB). Candidates
fetch the first visible diagram once after start and further simulated page views during the
soak, rather than preloading the paper. Set `REHEARSAL_MEDIA_REQUESTS` to the expected number of
image views. This repeats one compressed fixture; it does **not** establish browser caching,
layout, or diverse media behavior. Confirm fixture sizes and total view bytes match the real
paper before setting `REHEARSAL_REPRESENTATIVE_FIXTURE_CONFIRMED=1`; supplement with a browser
rehearsal of the actual private paper, option diagrams and mobile devices.

Require zero incorrect grades, duplicate results, stale-device/tab writes, cross-account answers,
or lost confirmed answers. Expected authorization/version/submission rejections are separate
from unexpected failures. Default p95 limits are dashboard/runtime ≤2,000 ms, autosave/final
sync/subject timing ≤1,000 ms, and start/submit/retry/login/refresh ≤3,000 ms. Unexpected errors
must be ≤1% for **every** measured operation, including attempted retries. Admin Realtime must
subscribe successfully. A request that later succeeds still counts its earlier unexpected error.

## Output and usage evidence

The latency table and `load.operations` include samples, errors, expected rejections,
p50/p95/p99/max, throughput, status/error breakdown and bounded redacted error samples. JSON is
saved to `logs/load-rehearsal/<run>.json` (mode 0600) and printed as the final stdout line.
Correctness or enforced threshold failure produces exit status 1. Secrets and addresses are redacted.

`finalizer.observations` records pending count, oldest pending deadline and scheduler state before,
during and after the run. The pending count includes expired sessions still inside the existing
120-second grace; oldest age plus scheduler status distinguishes normal grace from a stuck queue.
Use the optional abandonment burst at the intended cohort size to verify backlog drain. The
unchanged batch ceiling is 200 attempts/minute, so a burst may take several scheduler ticks;
examine drain rate and oldest age, not just the final count.

`usage` reports observed database size/growth and projected monthly growth/response payload bytes
using `REHEARSAL_MONTHLY_SITTINGS`. Response bytes include serialized RPC/Auth payloads and fetched
media, but exclude HTTP/TLS overhead, admin Realtime payloads and backups. Database growth between
two observations is noisy and can be zero because allocated pages are reused. These are planning
estimates, not billing counters. Also record the project's actual egress dashboard and relation/index
sizes before and after representative sittings, including paper copies, results and audit records.
Keep academic records; export and verify operator backups rather than delete records to fit a quota.
Confirm current Free quotas in the project dashboard and reserve space/egress for ordinary usage.

## Controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `REHEARSAL_CANDIDATE_COUNT` | 80 | Total candidates, 1–1000 |
| `REHEARSAL_CONCURRENCY` | candidate count | Rush worker limit; lower values stagger starts/submits |
| `REHEARSAL_PROVISION_CONCURRENCY` | 4 | Service-role setup workers |
| `REHEARSAL_AUTH_SIGNIN_DELAY_MS` | 3000 (local: 0) | Shared-IP login spacing; do not raise hosted limits just to pass |
| `REHEARSAL_SOAK_SECONDS` | 60 | Active workload length, 0–28800 seconds |
| `REHEARSAL_FULL_DURATION_SECONDS` | 0 | Intended complete sitting length; must be covered by the soak |
| `REHEARSAL_AUTOSAVE_MIN_MS` / `_MAX_MS` | 5000 / 20000 | Changed-answer interval; use >60000 to exercise timing fallback |
| `REHEARSAL_STUDENT_POLL_MIN_MS` / `_MAX_MS` | 20000 / 30000 | Completion-based dashboard/runtime jitter |
| `REHEARSAL_STALE_TAB_PERCENT` | 10 | Percentage sending one stale-version write |
| `REHEARSAL_TAKEOVER_PROBES` | min(3, count) | Second-device ownership probes |
| `REHEARSAL_RUSH_LEAD_MS` | 1000 | Start/submission barrier lead |
| `REHEARSAL_ABANDONMENT_PROBES` | 0 | Finalizer burst size; adds up to `4 + ceil(probes / 200)` minutes |
| `REHEARSAL_MEDIA_FILE` / `REHEARSAL_MEDIA_REQUESTS` | unset / 1 | Private representative image / views per candidate |
| `REHEARSAL_MONTHLY_SITTINGS` | 1 | Usage projection multiplier |
| `REHEARSAL_HOSTED_PLAN` | unset | Set `free` only after confirming actual hosted Free tier |
| `REHEARSAL_REPRESENTATIVE_FIXTURE_CONFIRMED` | unset | Set `1` after matching real paper/media sizes and views |
| `REHEARSAL_CAPACITY_REPORTS` | unset | Comma-separated prior JSON report paths |
| `REHEARSAL_REPORT_PATH` | generated under logs | Preserve each distinct report |
| `REHEARSAL_REALTIME_TIMEOUT_MS` | 15000 | Administrator subscription timeout |
| `REHEARSAL_MIN_REALTIME_SUBSCRIBE_RATE` | 1 | Administrator subscription success fraction |
| `REHEARSAL_THRESHOLDS` | default limits above | Diagnostic JSON overrides, e.g. `{"p95Ms":{"autosave":800}}` |
| `REHEARSAL_MAX_P95_AUTOSAVE_MS` / `REHEARSAL_MAX_ERROR_RATE` | 1000 / 0.01 | Threshold shorthands |
| `REHEARSAL_ENFORCE_THRESHOLDS` | 1 | `0` reports thresholds without enforcing them; cannot establish capacity |

Long runs require administrator refresh credentials supplied by the wrappers. Direct harness
runs need the URL, anon/service keys, AAL2 access token, `REHEARSAL_ADMIN_REFRESH_TOKEN`,
`REHEARSAL_ADMIN_EXPIRES_AT`, exact expected project ref and disposable confirmation. Treat
refresh credentials like passwords; never put them in report files or committed shell scripts.
Wrappers allow 20 minutes plus the soak: budget for login pacing, probes and abandonment. For a
large paced cohort, use a separately authorized direct run if the wrapper time budget is too short.

## Progressive hosted validation

First run local behavioral checks. Then, with an explicitly authorized disposable Free project,
start at a small cohort and increase gradually until a threshold fails. Compare runs under the
same representative existing data volume; empty staging is not enough. Re-run the highest passing
cohort at least **three** times with a full intended exam duration, refreshes, media, admin traffic,
start/submit bursts and abandonment. Include normal pacing and a realistic shared-school-IP
Auth/reconnect burst; never remove production anti-abuse controls to make a run pass.

Example short local smoke (the local stack must already be running):

```sh
REHEARSAL_CANDIDATE_COUNT=20 REHEARSAL_SOAK_SECONDS=120 npm run test:rehearsal:local
```

Example authorized disposable hosted run (choose the cohort and duration from measurements):

```sh
REHEARSAL_CONFIRM_DISPOSABLE=YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL \
REHEARSAL_HOSTED_PLAN=free REHEARSAL_CANDIDATE_COUNT=80 \
REHEARSAL_SOAK_SECONDS=7200 REHEARSAL_FULL_DURATION_SECONDS=7200 \
REHEARSAL_MEDIA_FILE=/absolute/path/representative-diagram.webp REHEARSAL_MEDIA_REQUESTS=20 \
REHEARSAL_REPRESENTATIVE_FIXTURE_CONFIRMED=1 REHEARSAL_ABANDONMENT_PROBES=80 \
REHEARSAL_MONTHLY_SITTINGS=8 npm run test:rehearsal:staging
```

Supply the previous report paths on the third run. `capacity.operatingCohort` is
`floor(0.70 × highest repeatedly passing concurrency)` and remains null without three distinct
same-project hosted Free runs meeting the full-duration/media/drill gates (abandonment at least the measured concurrency) and standard latency/error
limits. The tier and representative-fixture flags are operator attestations; retain dashboard proof
and browser evidence alongside reports. A successful short/local run never establishes hosted capacity.
Split sittings when demand exceeds the operating cohort.

The Node harness cannot simulate browser visibility/disposal, monotonic-clock changes, real offline
packet loss, device storage recovery, or an expiry racing a retry. Run the component/database tests
and a browser drill for hidden→visible/offline→online immediate refresh, re-grant generation rejection,
server-confirmed expiry grading, and honest locally pending recovery copy. Record these separately;
`operationalDrillsValidated` describes only the automated refresh/runtime/takeover/finalizer drills.
