# Stage 21 Authorization Manifest

This manifest is the reviewed browser/database contract, maintained through
Stage 22 migration `20260912155957`. It is deny-by-default. A database object is not browser-facing
unless it appears below. Row visibility is always the intersection of the
object grant and RLS policy; a grant alone is never authority.

## Principals

- **Anonymous:** no `public` table, view, sequence, or function access. Login is
  provided by Supabase Auth, not a public database object.
- **Student:** an authenticated account with a non-archived `students` row.
- **AAL1 administrator:** an authenticated `profiles.role = 'admin'` account
  whose JWT has not completed MFA. It can read only its own profile and call
  identity helpers that return no administrative data.
- **AAL2 administrator:** an authenticated administrator whose verified JWT has
  `aal = 'aal2'`.
- **Service role:** trusted server/maintenance context only. It bypasses RLS and
  receives explicit full privileges on every current application relation,
  sequence, and routine. It must never be shipped to a browser. Future objects
  still require an explicit migration grant.

## Relations exposed to `authenticated`

- `public.profiles`: `SELECT`. Students/AAL1 admins can read only their own row;
  AAL2 admins can read all rows. No browser writes.
- `public.students`: `SELECT` only on `id`, `student_id`, `name`, `class`,
  `section`, `created_at`, `active_auth_session_id`, and `archived_at`. Active
  students see only their own row; AAL2 admins see all rows. `archived_by` and
  `archive_reason` are available only through the bounded AAL2 roster RPC.
- `public.classes`: `SELECT`, `INSERT`, and `UPDATE`. Active students may read;
  only AAL2 admins may mutate. Direct `DELETE` is denied and must use
  `admin_delete_empty_class`.
- `public.cbt_exams_raw`: `SELECT` only on `id`, `title`, `status`, `class`,
  `section`, and `created_at`. Assigned active students and AAL2 admins may see
  matching rows. `questions_data` is never directly readable.
- `public.cbt_exams`: security-invoker view with `SELECT`, `INSERT`, and
  `UPDATE`. Assigned students receive metadata with the `questions` key removed;
  AAL2 admins receive the reconstructed paper. Only AAL2 admins may write via
  the guarded view trigger. Direct `DELETE` is denied and must use
  `admin_delete_unused_exam`.
- `public.cbt_exam_answers`: no browser privileges. RLS also limits reads to
  AAL2, but grading/reconstruction owner functions are the only application
  access path.
- `public.active_sessions`: `SELECT`. A student sees only the row that matches
  both its roster identity and current signed Auth session; AAL2 admins may
  inspect sessions. Browser writes are denied; authoritative RPCs own them.
- `public.student_results`: `SELECT`. Active students see only their own results;
  AAL2 admins see all. Browser writes are denied; submission owns grading.
- `public.question_bank`: `SELECT`, `INSERT`, and `UPDATE`, all restricted to
  AAL2 by RLS. Direct `DELETE` is denied and must use an audited question RPC.
- `public.question_import_batches`: `SELECT`, AAL2 only. Import writes occur
  inside `admin_import_questions`.
- `public.import_history`: `SELECT`, AAL2 only. Import writes occur inside the
  atomic import RPC.
- `public.admin_audit_events`: `SELECT`, AAL2 only. No browser writes.
- `public.exam_status_events`: `SELECT`. Assigned active students and AAL2
  admins see metadata-only exam status rows. Browser writes are denied.

All public base tables have RLS enabled. Browser roles cannot create objects in
`public`, and future application-owned tables, sequences, and functions receive
no browser privileges unless a later migration grants them explicitly.

## Browser RPC allowlist

Identity and policy helpers callable by every authenticated JWT:

- `current_auth_session_id()` reads only the caller's signed Auth session claim.
- `get_my_role()` returns only the caller's server-owned profile role.
- `is_admin_aal2()` returns a boolean; it does not grant authority by itself.
- `is_exam_asset_referenced(text)` is executable for Storage RLS evaluation but
  returns reference state only to AAL2/service contexts; other callers receive
  `false`. Input is capped at 1,024 bytes.

Student-only operations (an admin has no matching student row):

- `claim_student_session()`
- `release_student_session()`
- `start_exam_session(uuid, jsonb, jsonb)`
- `sync_active_session_progress(uuid, jsonb, integer)`
- `submit_exam(uuid, jsonb)`
- `terminate_exam(uuid)`
- `get_student_exam_result(text)`
- `exam_questions_for_viewer(uuid)`

`claim_student_session()` returns the current/new session identifier and
`replaced_existing_session`; it never returns the replaced identifier. A real
replacement records `STUDENT_SESSION_TAKEOVER` with empty metadata. Same-session
duplicate tabs do not create a takeover event.

Each operation checks caller ownership/current-session state internally.
Response JSON is capped at 256 KiB, the compatibility start payload is capped at
8 MiB, and result identifiers are capped at 128 bytes. Submission is serialized
and idempotent. Takeover and student exam writes share the same transaction lock,
so the old device either completes before replacement or is denied after it. A
retry after a lost submission response may read the already committed immutable
result but cannot create a result from a replaced session.

AAL2 administrator-only operations (each repeats its AAL2 check internally):

- `get_db_size()`
- `admin_operational_health()`
- `get_unreferenced_exam_assets()` — capped at 500 rows
- `record_exam_asset_cleanup(text[])` — 1..100 unique paths, each <= 1,024 bytes
- `preflight_validate_exam(uuid)`
- `admin_finalize_expired_sessions(integer)` — batch 1..500
- `admin_delete_question(uuid)`
- `admin_clear_question_bank(text)`
- `admin_delete_unused_exam(uuid, text)`
- `admin_deactivate_students(uuid[], text)` — 1..100 unique students
- `admin_reactivate_students(uuid[])` — 1..100 unique students
- `admin_delete_empty_class(uuid, text)`
- `admin_update_student_assignment(uuid, text, text)`
- `admin_import_questions(uuid, text, jsonb)` — 1..500 rows and <= 5 MiB
- `record_result_export(uuid, text, integer)` — expected count 1..20,000
- `get_admin_student_roster_page(integer, integer, text, text, text)`
- `get_admin_question_bank_page(integer, integer, text, text, text)`
- `get_admin_questions_by_ids(uuid[])` — 1..500 unique IDs
- `get_admin_exam_list_page(integer, integer, text, text)`
- `get_admin_exam_results_page(uuid, integer, integer, text, integer)`
- `get_admin_exam_results_export_page(uuid, text, integer, integer)`

Admin page sizes are capped at 100, 200, or 500 according to the endpoint;
search and filter inputs are capped at 100 characters. Result export counts are
capped at 20,000.

## Internal-only public-schema routines

The following routines have no `anon` or `authenticated` execute privilege.
They are reached only by triggers, another reviewed routine, migration code, or
the service role:

- `assert_current_student_session`
- `assert_exam_payload_bounds`
- `assert_exam_required_media`
- `audit_class_admin_change`
- `audit_exam_admin_change`
- `audit_provisioned_student`
- `audit_question_admin_change`
- `block_direct_cbt_exams_raw_writes`
- `canonical_question_text`
- `cleanup_unreferenced_exam_assets`
- `delete_students`
- `delete_user`
- `exam_progress_to_submission`
- `handle_cbt_exams_modification`
- `handle_new_user`
- `normalize_submission_response_map`
- `protect_class_deletion`
- `protect_committed_student_results`
- `protect_exam_deletion`
- `protect_inactive_student_assignment`
- `reconstruct_exam_questions`
- `sanitize_exam_responses`
- `start_exam_session_stage3_internal`
- `submit_exam_stage3_internal`
- `sync_active_session_progress_stage3_internal`
- `sync_exam_status_event`
- `terminate_exam_stage3_internal`
- `validate_cbt_exams_raw_record`
- `validate_exam_required_media_record`
- `validate_full_exam_paper`
- `validate_full_exam_paper_stage1_internal`
- `validate_question_bank_content`
- `validate_result_exam_reference`
- `validate_student_record`

Every public `SECURITY DEFINER` routine has `search_path = ''` in the live
catalog. Application relations and helper routines used by newly hardened
authority functions are schema-qualified.

## Realtime

The `supabase_realtime` publication contains only:

- `classes`
- `exam_status_events`
- `question_bank`
- `student_results`
- `students`

`cbt_exams_raw` is deliberately absent. Exam changes are copied by an internal
trigger into `exam_status_events`, whose only fields are `exam_id`, `title`,
`status`, `class`, `section`, and `changed_at`. RLS is still enforced for every
published table. Realtime is a refresh signal; polling/re-fetching through REST
remains authoritative.

## Storage and Edge Function

- Bucket `exam-assets` is private, limited to 5 MiB, and accepts only JPEG, PNG,
  and WebP declarations.
- AAL2 admins may upload/update. Delete is allowed only when the reference check
  proves the object unused.
- A student may obtain a signed read URL only when its current authoritative
  exam session references that exact object path.
- `manage-student` validates the caller JWT and AAL2 state using the caller
  client before its server-side service client provisions or updates records.
  The service credential is never returned to the browser.

## Verification source

`supabase/tests/stage21_authorization_matrix.sql` is the executable manifest.
It verifies grants, safe columns, exact RPC allowlisting, AAL1/AAL2 behavior,
assigned/unassigned/archived student access, own-row isolation, Storage bucket
configuration, Realtime contents, RLS coverage, default privileges, internal
function denial, and privileged-function search paths.
