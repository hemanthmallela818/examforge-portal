# ExamForge client handover checklist

This checklist separates repository work from deployment work. Production remains untouched by the repository-readiness work.

## Completed evidence

- [x] Local migrations replay and local database/security tests.
- [x] Unit, contract, accessibility, scoring, recovery, and regression suites.
- [x] Lint, typecheck, production build, and dependency audit (last successful audit: 0 vulnerabilities).
- [x] Local browser coverage across Chromium, Firefox, and WebKit paths.
- [x] 80-candidate staging rehearsal, private Storage recovery, and logical database restore.
- [x] Corrected 100-candidate staging rehearsal with timing report and bounded fixture cleanup.
- [x] Staging operator drill: AAL1/AAL2, emergency ending, MFA recovery, health, audit, cleanup.
- [x] Current staging Edge Function uses the hardened provisioning implementation.
- [x] Hosted GitHub CI for handover commit: quality/coverage/build/audit and clean local-Supabase browser E2E all passed.

## Remaining pre-handover gates

- [ ] Rotate the secret key exposed by the malformed ignored environment-file line.
- [ ] Enable leaked-password protection in staging and production.
- [ ] Verify production migration parity and deploy the current Edge Function during deployment.
- [ ] Configure production Auth URLs, exact CORS origins, email delivery, private Storage, and admin MFA.
- [ ] Configure monitoring, alerts, rate limits, backups/PITR, and an on-call owner.
- [ ] Complete real-device/browser accessibility acceptance and client workflow sign-off.

## Commands for the next validation window

```powershell
$env:REHEARSAL_CONFIRM_DISPOSABLE='YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL'
$env:REHEARSAL_CANDIDATE_COUNT='100'
npm run test:rehearsal:staging
npm run ops:drill:staging
npm run ops:prove-storage-restore:staging
npm run ops:prove-restore:staging
```

The rehearsal and restore commands are restricted to `jee-staging`. Never set their expected project to production.

## Client handover package

Give the client the repository, [SETUP.md](../SETUP.md), [SECURITY.md](../SECURITY.md), [OPERATIONS_AND_DISASTER_RECOVERY.md](OPERATIONS_AND_DISASTER_RECOVERY.md), this checklist, and the final CI/rehearsal evidence. Transfer credentials through the client's approved secret manager, not through Git, chat, screenshots, or `VITE_` variables.
