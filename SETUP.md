# Setup and Release Guide

## 1. Workstation preparation

1. Install Node.js 22.13.0 or newer in the Node 22 line.
2. Install and start Docker Desktop.
3. Run `npm ci` from the repository root.
4. Copy `.env.example` to `.env`. Set only the hosted or local Supabase URL and public anon/publishable key.

Never expose a service-role key, database password, administrator access token, or monitoring auth token through a `VITE_` variable.

## 2. Local Supabase

Start and rebuild the isolated local stack:

```text
npm run supabase:local -- start
npm run supabase:local -- db reset --local
```

The reset is destructive to local Supabase data and replays every migration in timestamp order. It does not target a hosted project.

Configure the local `manage-student` function secret `ALLOWED_ORIGINS` with exact browser origins such as `http://localhost:5173` and `http://127.0.0.1:4173`. The function deliberately rejects browser origins when this setting is absent.

## 3. Hosted staging

Use a dedicated disposable staging project. Do not link release rehearsals to production.

1. Apply every file in `supabase/migrations/` in timestamp order.
2. Deploy `supabase/functions/manage-student` with JWT verification enabled.
3. Set `ALLOWED_ORIGINS` to the exact staging application origin; do not use `*`.
4. Disable public registration, anonymous sign-in, and SMS sign-up.
5. Keep email/password sign-in enabled for provisioned accounts.
6. Require a minimum 12-character password, enable administrator TOTP, enable leaked-password protection, and tune sign-in throttling from rehearsal evidence.
7. Keep the `exam-assets` bucket private.
8. Run Supabase security and performance advisors after every schema change.

## 4. Bootstrap the first administrator

From a trusted terminal, set these server-side variables without saving them in the repository:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
BOOTSTRAP_ADMIN_EMAIL
BOOTSTRAP_ADMIN_PASSWORD
BOOTSTRAP_ADMIN_NAME (optional)
```

Run `npm run admin:bootstrap`, sign in, enroll TOTP immediately, and remove the bootstrap variables from the terminal environment.

## 5. Quality gates

Run:

```text
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

The coverage gate requires at least 85% lines, 70% branches, and 90% functions across the instrumented logic modules. Playwright exercises the supported Chromium, Firefox, and WebKit projects.

## 6. Disposable staging rehearsal

Set all of the following in a trusted terminal:

```text
REHEARSAL_SUPABASE_URL
REHEARSAL_SUPABASE_ANON_KEY
REHEARSAL_SUPABASE_SERVICE_ROLE_KEY
REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN
REHEARSAL_EXPECTED_PROJECT_REF
REHEARSAL_CONFIRM_DISPOSABLE=YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL
REHEARSAL_AUTH_SIGNIN_DELAY_MS (optional; default 3000)
REHEARSAL_CANDIDATE_COUNT=100
```

Then run `npm run test:rehearsal`.

The hostname must exactly match `REHEARSAL_EXPECTED_PROJECT_REF`. Set `REHEARSAL_CANDIDATE_COUNT=100` for the client handover gate. The harness creates that many students and an exam, verifies answer secrecy and blocked unauthorized writes, opens one Realtime channel per candidate, starts and submits every attempt, reports p50/p95/p99 timings, and verifies exact stored scores and result cardinality. Values from 1 through 1,000 are accepted; do not increase the value without a capacity plan.

To add the service-role key and AAL2 administrator token without echoing either value, run this from PowerShell and follow the two secure prompts:

```powershell
& .\scripts\set-staging-rehearsal-secrets.ps1
```

The helper writes only to `.env.rehearsal.local`, which is ignored by Git. Delete that file immediately after the staging rehearsal and project reset.

The rehearsal does **not** remove immutable academic records. This is intentional: cleanup must never weaken retention guarantees. Record the report, then reset the entire disposable staging project before reuse. Never run the rehearsal against production.

Run the operator acceptance drill after the rehearsal:

```text
npm run ops:drill:staging
```

It verifies AAL1 denial, AAL2 exam lifecycle controls, emergency exam ending, lost-TOTP-factor recovery, operational health, audit events, and bounded cleanup.

## 7. Release rule

Do not admit real candidates until every release blocker in `PRODUCTION_READINESS_REPORT.md` has objective evidence. Deployment-time items include expected-concurrency load evidence, real-device and assisted accessibility acceptance, hosted backup/restore timing, monitoring and alerting, operator ownership, rate-limit tuning, secret rotation, and security-header verification on the real domain.

## 8. Production Vercel deployment

The production Supabase project is `jee Project` (`hetaoesxoicqreobjqpy`). In Vercel:

1. Import `hemanthmallela818/examforge-portal` and select the `main` branch.
2. Set the project name to `examforge-portal`. This produces the exact production origin currently allowed by the Edge Function: `https://examforge-portal.vercel.app`.
3. Keep the detected framework as Vite, build command as `npm run build`, and output directory as `dist`.
4. The repository's `.env.production` supplies `VITE_SUPABASE_URL` and the production **publishable** key so a clean Vercel build cannot start without its public service configuration.
5. Vercel Production environment variables with the same names may override these browser-safe defaults when rotating the publishable key. Never use a secret or service-role key.
6. Deploy, then verify `/` returns the security headers defined in `vercel.json`.
7. Test student login, administrator login, root administrator creation, private question images, exam start/autosave/offline reconnect/submit, and result revisit on the published domain.

If the Vercel project name or custom domain differs, update the Supabase `ALLOWED_ORIGINS` Edge Function secret to that exact HTTPS origin before using administrator/student provisioning. Do not add a wildcard or preview-domain pattern to the production backend.
