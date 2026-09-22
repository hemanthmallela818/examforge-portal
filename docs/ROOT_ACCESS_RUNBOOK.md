# Root developer and administrator access

This project has one root developer and no public account creation.

1. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in a private operator shell. Set `BOOTSTRAP_ROOT_EMAIL`, `BOOTSTRAP_ROOT_PASSWORD`, and optionally `BOOTSTRAP_ROOT_NAME` there as well.
2. Run `npm run root:bootstrap` once against the intended Supabase project. The script is idempotent for the same root email and refuses to replace a different existing owner.
3. Sign in to the Admin Login screen with the root email and password. Password sign-in does not open an MFA prompt.
4. Open **Root developer — Manage administrators**. Create administrator accounts there. The password is held only in the form and is never written to the database or browser storage.
5. Administrators sign in with their assigned password and create student accounts through the normal student-management workflow. There is no public signup path.
6. Disable an administrator from the same root panel when access must be revoked. Existing sessions are denied on their next protected request because authorization is checked in Postgres.

## Reuse the installation

The root developer can also clear reusable data independently without deleting students:

1. Open **Database Maintenance & Cleaner**.
2. Download/export **Exam Results**, then select **Clear Exam Results** and type `CLEAR EXAM RESULTS`.
3. If needed, use the existing **Finalize Expired Attempts** action for active sessions. The exam cleanup will refuse to run while results or active sessions remain.
4. Select **Clear Exams & Schedules** and type `CLEAR EXAMS`.
5. Select **Clear Question Bank** and type `CLEAR QUESTION BANK` when reusable questions are no longer needed.

Each action is root-only, audited, and refreshes only the affected collection. Student accounts, student roster records, classes, administrator accounts, and private Storage files are preserved.

Only the root developer can perform a complete application-data reset:

1. Open **Database Maintenance & Cleaner** and select **Reset Application Data**.
2. Review the server-provided counts. Type `RESET APPLICATION DATA` exactly and accept the final irreversible-action confirmation.
3. Wait for the success message and refreshed zero counts before creating the next classes, students, questions, and exams.

The reset removes student sign-in accounts, results, exams, active sessions, students, classes, reusable questions, import records, import batches, and previous administrator audit events. It preserves the root developer and all administrator accounts, then records one new reset audit event. Files in the private `exam-assets` Storage bucket are intentionally retained and can be reviewed separately from **Operations & Audit**.

If Auth cleanup is interrupted after the transactional database reset, the screen reports an error and a correlation ID. Run the same reset again; remaining student profiles are retained specifically so their Auth deletion can be retried safely.

The root bootstrap command is an operator action. Never put the service-role key or a real password in the repository, CI logs, screenshots, or a client-side environment variable.
