# ExamForge Portal

ExamForge is a security-focused computer-based examination portal for JEE-style assessments. It provides administrator-managed accounts, reviewed JSON question import, private question media, server-owned exam timing and grading, resumable candidate sessions, idempotent submission, audited exports, and operational health tooling.

The browser is intentionally not trusted for authorization, answer-key access, timing, grading, or academic-record mutation. Those controls are enforced by Supabase Auth, PostgreSQL row-level security, privileged RPCs, and the `manage-student` Edge Function.

## Requirements

- Node.js 22.13.0 or newer in the Node 22 line
- npm (the version bundled with Node 22 is supported)
- Docker Desktop for the local Supabase stack
- A separate Supabase project for each hosted environment

## Start locally

```text
npm ci
npm run supabase:local -- start
npm run supabase:local -- db reset --local
```

Copy `.env.example` to `.env`, replace both placeholders with the values printed by the local Supabase status command, and then start the application:

```text
npm run dev
```

Never put a service-role key, database password, admin token, or Sentry auth token in a `VITE_` variable. Every `VITE_` value is embedded in the public browser bundle.

See [SETUP.md](SETUP.md) for hosted-environment setup and first-administrator provisioning.

## Release checks

Run these from a clean checkout with Docker Desktop available:

```text
npm ci
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm audit --audit-level=high
npm run test:e2e:local
npm run test:rehearsal:local
npm run ops:check:local
npm run ops:prove-restore:local
npm run ops:prove-storage-restore:local
```

`test:e2e:local` destroys and rebuilds only the local Supabase database. The rehearsal intentionally leaves immutable academic records behind, so reset the disposable target after recording its results. Never point a rehearsal or reset command at production.

## Architecture and safety boundaries

- `src/` contains the React/Vite browser application.
- `supabase/migrations/` is the forward-only database history and authorization source of truth.
- `supabase/functions/manage-student/` contains the JWT-protected account-provisioning Edge Function.
- `tests/` contains unit, contract, database, migration, security, and regression checks.
- `e2e/` contains authenticated Chromium, Firefox, and WebKit journeys.
- `docs/` contains import, authorization, operations, backup, and disaster-recovery runbooks.

Important operating rules:

- Administrators use password sign-in; server-side managed-account authorization protects protected actions.
- Public sign-up stays disabled; accounts are created through trusted provisioning paths.
- The `exam-assets` bucket remains private and is accessed through short-lived signed URLs.
- Only the newest signed student session can mutate an attempt; an older device becomes read-only.
- Local browser recovery is device-local and cannot recover answers that were never confirmed by the server.
- Submitted results are immutable academic records.

## Configuration

The browser requires only:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Server-side scripts read their own non-`VITE_` variables. The full list and safe handling instructions are in [SETUP.md](SETUP.md). Operational recovery procedures are in [docs/OPERATIONS_AND_DISASTER_RECOVERY.md](docs/OPERATIONS_AND_DISASTER_RECOVERY.md).

## Deployment status

Deployment is intentionally outside this repository-readiness pass. Before serving real candidates, complete the staging rehearsal, hosted CI, expected-concurrency load test, real-device accessibility acceptance, backup/restore drill, monitoring configuration, and hosting-header verification recorded in [PRODUCTION_READINESS_REPORT.md](PRODUCTION_READINESS_REPORT.md).

## Security

Do not report vulnerabilities in a public issue or include credentials in a bug report. Follow [SECURITY.md](SECURITY.md).
