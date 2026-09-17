# Setup and Release Guide

## Clean installation

1. Install Node.js 20+ and run `npm ci`.
2. Copy `.env.example` to `.env`; set the Supabase URL and public anonymous key. Never expose the service-role key in a `VITE_` variable.
3. Create/link an isolated Supabase project and apply every file in `supabase/migrations` in timestamp order.
4. Deploy `supabase/functions/manage-student` with JWT verification enabled.
5. Disable public registration in Supabase Auth. Enable a strong password policy, sign-in throttling, and MFA for administrators.
6. Bootstrap the first administrator from a trusted terminal. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (12+ characters), and optionally `BOOTSTRAP_ADMIN_NAME`; run `npm run admin:bootstrap`. Do not save these server secrets in this repository.
7. Configure the `manage-student` Edge Function secret `ALLOWED_ORIGINS` as a comma-separated list of exact application origins (for example, `http://localhost:5173` locally). The function deliberately rejects browser origins when this value is absent.
7. Run `npm test` and `npm run build`.

## Staging rehearsal

Set `REHEARSAL_SUPABASE_URL`, `REHEARSAL_SUPABASE_ANON_KEY`, and `REHEARSAL_SUPABASE_SERVICE_ROLE_KEY`, then run `npm run test:rehearsal` against staging only.

The rehearsal creates 80 temporary students and an exam, verifies hidden answers and blocked unauthorized writes, opens 80 Realtime channels, starts/submits every attempt, validates stored scores, and cleans up. Never point it at production because it intentionally creates and deletes Auth users and test records.

## Release rule

Do not admit real candidates until every P0 item in `PRODUCTION_READINESS_REPORT.md` passes and backup restoration plus a real-device/network dress rehearsal have been completed.
