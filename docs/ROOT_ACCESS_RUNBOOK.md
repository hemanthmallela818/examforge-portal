# Root developer and administrator access

This project has one root developer and no public account creation.

1. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in a private operator shell. Set `BOOTSTRAP_ROOT_EMAIL`, `BOOTSTRAP_ROOT_PASSWORD`, and optionally `BOOTSTRAP_ROOT_NAME` there as well.
2. Run `npm run root:bootstrap` once against the intended Supabase project. The script is idempotent for the same root email and refuses to replace a different existing owner.
3. Sign in to the Admin Login screen with the root email and password. Password sign-in does not open an MFA prompt.
4. Open **Root developer — Manage administrators**. Create administrator accounts there. The password is held only in the form and is never written to the database or browser storage.
5. Administrators sign in with their assigned password and create student accounts through the normal student-management workflow. There is no public signup path.
6. Disable an administrator from the same root panel when access must be revoked. Existing sessions are denied on their next protected request because authorization is checked in Postgres.

The root bootstrap command is an operator action. Never put the service-role key or a real password in the repository, CI logs, screenshots, or a client-side environment variable.
