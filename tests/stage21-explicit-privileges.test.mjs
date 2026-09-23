import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20260912102558_stage21_explicit_data_api_privileges.sql', import.meta.url);
const platformDefaultsMigrationUrl = new URL('../supabase/migrations/20260912103030_stage21_supabase_admin_default_privileges.sql', import.meta.url);
const deleteBoundaryMigrationUrl = new URL('../supabase/migrations/20260912154147_stage21_restore_audited_delete_boundaries.sql', import.meta.url);
const serviceRoleMigrationUrl = new URL('../supabase/migrations/20260912154651_stage21_explicit_service_role_privileges.sql', import.meta.url);
const canonicalQuestionGrantMigrationUrl = new URL('../supabase/migrations/20260923080203_restore_canonical_question_text_execute.sql', import.meta.url);

test('Stage 21 Data API privileges are deny-by-default and explicitly allowlisted', async () => {
  const [migration, platformDefaultsMigration, deleteBoundaryMigration, serviceRoleMigration, config] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(platformDefaultsMigrationUrl, 'utf8'),
    readFile(deleteBoundaryMigrationUrl, 'utf8'),
    readFile(serviceRoleMigrationUrl, 'utf8'),
    readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8')
  ]);

  assert.match(config, /^auto_expose_new_tables = false$/m);
  assert.match(migration, /REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /ALTER DEFAULT PRIVILEGES FOR ROLE postgres[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(platformDefaultsMigration, /pg_catalog\.pg_has_role\(current_user, 'supabase_admin', 'MEMBER'\)/);
  assert.match(platformDefaultsMigration, /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin[\s\S]*REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated/);
  assert.match(platformDefaultsMigration, /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin[\s\S]*REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated/);
  assert.match(platformDefaultsMigration, /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin[\s\S]*REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated/);
  assert.match(migration, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT SELECT \(id, title, status, class, section, created_at\)[\s\S]*public\.cbt_exams_raw TO authenticated/);
  assert.match(migration, /GRANT SELECT \([\s\S]*active_auth_session_id,[\s\S]*archived_at[\s\S]*\) ON TABLE public\.students TO authenticated/);
  assert.match(migration, /REVOKE ALL PRIVILEGES ON TABLE public\.cbt_exam_answers FROM anon, authenticated/);
  assert.match(deleteBoundaryMigration, /REVOKE DELETE ON TABLE public\.cbt_exams FROM authenticated/);
  assert.match(deleteBoundaryMigration, /REVOKE DELETE ON TABLE public\.classes FROM authenticated/);
  assert.match(deleteBoundaryMigration, /REVOKE DELETE ON TABLE public\.question_bank FROM authenticated/);
  assert.match(deleteBoundaryMigration, /WHEN NOT public\.is_admin_aal2\(\) THEN false/);
  assert.match(serviceRoleMigration, /GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role/);
  assert.match(serviceRoleMigration, /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role/);

  for (const rpc of [
    'claim_student_session', 'release_student_session', 'start_exam_session',
    'sync_active_session_progress', 'submit_exam', 'terminate_exam',
    'get_student_exam_result', 'exam_questions_for_viewer',
    'admin_operational_health', 'admin_import_questions',
    'get_admin_student_roster_page', 'get_admin_question_bank_page',
    'get_admin_exam_list_page', 'get_admin_exam_results_page'
  ]) {
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\(`));
  }

  for (const internal of [
    'audit_exam_admin_change', 'audit_question_admin_change',
    'reconstruct_exam_questions', 'sanitize_exam_responses',
    'normalize_submission_response_map', 'handle_new_user',
    'validate_full_exam_paper', 'handle_cbt_exams_modification'
  ]) {
    assert.doesNotMatch(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${internal}\\([^;]*TO authenticated`));
  }
});

test('question validation restores only the authenticated canonical-text helper grant', async () => {
  const migration = await readFile(canonicalQuestionGrantMigrationUrl, 'utf8');

  assert.match(migration, /REVOKE ALL ON FUNCTION public\.canonical_question_text\(text\) FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.canonical_question_text\(text\) TO authenticated, service_role/);
  assert.doesNotMatch(migration, /TO anon/);
});
