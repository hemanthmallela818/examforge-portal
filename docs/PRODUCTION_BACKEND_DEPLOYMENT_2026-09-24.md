# Production backend deployment — 24 September 2026
## Target

- Supabase project: `jee Project`
- Project reference: `hetaoesxoicqreobjqpy`
- Expected Vercel production origin: `https://examforge-portal.vercel.app`
- GitHub repository: `hemanthmallela818/examforge-portal`

## Completed production changes

- Created pre-change production dumps of the `public`, `auth`, and `storage` schemas and data in the operator's local temporary backup directory.
- Reconciled 30 name-for-name migration records that had been applied through deployment-time timestamps.
- Applied `20260923175028_fix_optional_legacy_cleanup_lint.sql`.
- Confirmed a subsequent production migration dry-run is up to date with zero pending migrations.
- Deployed `manage-student` version 10 with JWT verification enabled.
- Set `ALLOWED_ORIGINS` to the exact expected Vercel origin.
- Set the Auth Site URL to the expected Vercel origin.
- Disabled public and anonymous sign-up paths while preserving provisioned email/password accounts.
- Enabled email confirmation and secure password changes.
- Raised the hosted minimum password length from 6 to 10 characters.
- Preserved enabled TOTP enrollment and verification.
- Enabled mandatory SSL for external database connections.

## Production verification

- Database lint: no schema errors.
- Operational health: `HEALTHY`; no active sessions, expired sessions, missing media, inactive students, or unreferenced private assets were reported.
- Root authority smoke test: root one-time session, administrator creation, student creation, administrator disable, and access revocation passed; temporary identities were removed.
- Root-only reset preview authorization passed without executing a reset.
- Expected Vercel origin reached the Edge Function and received the exact matching CORS header.
- An untrusted origin received HTTP 403 and no allow-origin header.
- Production hierarchy and private data were not reset or load-tested. Disposable staging remains the only permitted remote rehearsal target.

## Repository verification

- ESLint: pass, zero warnings.
- TypeScript: pass.
- Unit/contract/security suite: 256/256 pass.
- Coverage: 96.98% lines, 80.72% branches, 97.65% functions.
- Production Vite build: pass, 728 modules.
- Dependency audit: zero vulnerabilities.
- Full local browser suite immediately before production promotion: 42/42 pass across Chromium, Firefox, and WebKit.
- Local 80-candidate rehearsal immediately before production promotion: 80/80 successful submissions and retries, zero duplicates or cross-account answer loss.

## Vercel publication steps

1. Import the GitHub repository and deploy the `main` branch.
2. Use Vercel project name `examforge-portal`.
3. Set `VITE_SUPABASE_URL=https://hetaoesxoicqreobjqpy.supabase.co`.
4. Set `VITE_SUPABASE_ANON_KEY` to the production Supabase **publishable** key.
5. Verify the assigned production URL is exactly `https://examforge-portal.vercel.app`. If it differs, update both the Supabase Auth Site URL and Edge Function `ALLOWED_ORIGINS` before client use.
6. Verify the response headers from `vercel.json`, then run the published-domain login, provisioning, private-image, offline/reconnect, submission, and result-revisit smoke tests.

## Operator-only follow-up

- Leaked-password protection is a Supabase Pro feature and was not confirmed through the CLI configuration surface. Enable and verify it in Auth settings if the production plan supports it.
- Configure a production SMTP provider before depending on email confirmation, recovery, or security-notification delivery; the default service is not a production mail system.
- Configure monitoring, alerting, backup/PITR retention, rate limits, incident contacts, and the client acceptance window.
