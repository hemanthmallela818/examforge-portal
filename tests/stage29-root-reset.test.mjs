import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('root reset is explicitly authorized, confirmed, auditable, and preserves administrator identities', async () => {
  const migration = await read('supabase/migrations/20260922050131_root_application_data_reset.sql');
  const lintFix = await read('supabase/migrations/20260923175028_fix_optional_legacy_cleanup_lint.sql');

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.root_application_reset_preview\(\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.root_reset_application_data\(confirmation_param text\)/);
  assert.match(migration, /IF NOT public\.is_root_developer\(\)/);
  assert.match(migration, /confirmation_param IS DISTINCT FROM 'RESET APPLICATION DATA'/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /p\.role IS DISTINCT FROM 'admin'/);
  assert.match(migration, /application_owner[\s\S]*?managed_administrators/);
  assert.match(migration, /set_config\('cbt\.trusted_result_retention', 'on', true\)[\s\S]*?DELETE FROM public\.student_results/);
  assert.match(migration, /set_config\('cbt\.trusted_exam_context', 'on', true\)[\s\S]*?DELETE FROM public\.cbt_exams_raw/);
  assert.match(migration, /DELETE FROM public\.admin_audit_events[\s\S]*?'RESET_APPLICATION_DATA'/);
  assert.match(migration, /to_regclass\('public\.proctor_flags'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.root_reset_application_data\(text\) FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.root_reset_application_data\(text\) TO authenticated/);
  assert.match(lintFix, /table_name_param NOT IN \('attempts', 'exams', 'questions', 'proctor_flags', 'live_feeds'\)/);
  assert.match(lintFix, /format\('DELETE FROM %I\.%I WHERE true', 'public', table_name_param\)/);
  assert.match(lintFix, /REVOKE ALL ON FUNCTION public\.root_delete_optional_legacy_table\(text\) FROM PUBLIC, anon, authenticated/);
});

test('root reset uses the server function for Auth cleanup and never exposes service credentials', async () => {
  const [edge, authority] = await Promise.all([
    read('supabase/functions/manage-student/index.ts'),
    read('supabase/migrations/20260922051425_root_reset_edge_only_authority.sql'),
  ]);

  assert.match(edge, /action === 'preview-reset' \|\| action === 'reset-application'/);
  assert.match(edge, /caller\.rpc\('is_root_developer'\)/);
  assert.match(edge, /isRootOnlyAction = \['create-admin', 'preview-reset', 'reset-application', 'clear-scoped-data'\]/);
  assert.match(edge, /if \(!isRootOnlyAction\)/);
  assert.match(edge, /admin\.rpc\('root_application_reset_preview_for_actor'/);
  assert.match(edge, /admin\.rpc\('root_reset_application_data_for_actor'/);
  assert.match(edge, /resetError\?\.message \|\| 'Application data reset failed'/);
  assert.match(edge, /admin\.auth\.admin\.deleteUser\(accountId\)/);
  assert.match(edge, /offset \+= 10/);
  assert.doesNotMatch(edge, /return json\(request, \{[^}]*auth_user_ids/);
  assert.match(authority, /REVOKE ALL ON FUNCTION public\.root_reset_application_data\(text\) FROM authenticated/);
  assert.match(authority, /application_owner[\s\S]*?owner\.user_id = actor_id_param/);
  assert.match(authority, /GRANT EXECUTE ON FUNCTION public\.root_reset_application_data_for_actor\(uuid, text\) TO service_role/);
  assert.doesNotMatch(authority, /TO authenticated/);
});

test('only the root UI exposes the destructive reset with preview and two confirmations', async () => {
  const [dashboard, cleaner] = await Promise.all([
    read('src/components/AdminDashboard.jsx'),
    read('src/components/AdminDatabaseCleanerView.jsx'),
  ]);

  assert.match(cleaner, /isRootDeveloper &&/);
  assert.match(cleaner, /Root Developer Reset/);
  assert.match(cleaner, /root account and administrator accounts are preserved/i);
  assert.match(cleaner, /Private Storage files are not removed/);
  assert.match(dashboard, /action: 'preview-reset'/);
  assert.match(dashboard, /Type RESET APPLICATION DATA to continue/);
  assert.match(dashboard, /This operation cannot be undone/);
  assert.match(dashboard, /action: 'reset-application'/);
  assert.match(dashboard, /readFunctionInvocationError\(resetResult, 'Application reset failed'\)/);
  assert.match(dashboard, /isRootDeveloper=\{isRootDeveloper\}/);
});

test('the connected staging reset proof is inert without a second explicit destructive confirmation', async () => {
  const proof = await read('scripts/verify-connected-staging-reset.mjs');
  assert.match(proof, /RESET_CONFIRM_DISPOSABLE/);
  assert.match(proof, /YES_RESET_JEE_STAGING_APPLICATION_DATA/);
  assert.match(proof, /Explicit destructive staging reset confirmation is required/);
});

test('root cleanup actions are independently scoped and never target student accounts', async () => {
  const [migration, safeUpdateMigration, edge, dashboard, cleaner] = await Promise.all([
    read('supabase/migrations/20260922110000_root_scoped_cleanup_actions.sql'),
    read('supabase/migrations/20260923080741_make_root_cleanup_safeupdate_compatible.sql'),
    read('supabase/functions/manage-student/index.ts'),
    read('src/components/AdminDashboard.jsx'),
    read('src/components/AdminDatabaseCleanerView.jsx'),
  ]);

  assert.match(migration, /root_clear_results/);
  assert.match(migration, /root_clear_exams/);
  assert.match(migration, /root_clear_questions/);
  assert.match(migration, /target_param NOT IN \('student_results', 'cbt_exams', 'question_bank'\)/);
  assert.doesNotMatch(migration, /DELETE FROM public\.students/);
  assert.doesNotMatch(migration, /DELETE FROM public\.profiles/);
  assert.match(edge, /action === 'clear-scoped-data'/);
  assert.match(edge, /CLEAR EXAM RESULTS/);
  assert.match(edge, /root_clear_scoped_data_for_actor/);
  assert.match(dashboard, /handleRootScopedClear/);
  assert.match(dashboard, /CLEAR EXAMS/);
  assert.match(cleaner, /Clear Exam Results/);
  assert.match(cleaner, /Clear Exams & Schedules/);
  assert.match(cleaner, /Student accounts and administrator accounts are never removed/);
  assert.match(safeUpdateMigration, /DELETE FROM public\.student_results WHERE true/);
  assert.match(safeUpdateMigration, /DELETE FROM public\.cbt_exams_raw WHERE true/);
  assert.match(safeUpdateMigration, /DELETE FROM public\.question_bank WHERE true/);
  assert.match(safeUpdateMigration, /DELETE FROM public\.students WHERE true/);
  assert.doesNotMatch(safeUpdateMigration, /DELETE FROM public\.profiles/);
});
