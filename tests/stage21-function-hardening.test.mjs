import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const identityMigrationUrl = new URL(
  '../supabase/migrations/20260912103415_stage21_identity_session_function_hardening.sql',
  import.meta.url
);
const examMigrationUrl = new URL(
  '../supabase/migrations/20260912103740_stage21_exam_authority_function_hardening.sql',
  import.meta.url
);
const remainingDefinersMigrationUrl = new URL(
  '../supabase/migrations/20260912104336_stage21_remaining_definer_search_path_hardening.sql',
  import.meta.url
);
const realtimeMigrationUrl = new URL(
  '../supabase/migrations/20260912104627_stage21_safe_exam_realtime_surface.sql',
  import.meta.url
);
const boundsMigrationUrl = new URL(
  '../supabase/migrations/20260912144148_stage21_authoritative_input_bounds.sql',
  import.meta.url
);
const volatilityMigrationUrl = new URL(
  '../supabase/migrations/20260912145433_stage21_function_volatility_corrections.sql',
  import.meta.url
);
const rosterIndexMigrationUrl = new URL(
  '../supabase/migrations/20260912145733_stage21_roster_order_index.sql',
  import.meta.url
);

test('Stage 21 identity and session functions use empty search paths and qualified authority checks', async () => {
  const sql = await readFile(identityMigrationUrl, 'utf8');

  for (const functionName of [
    'is_admin_aal2',
    'get_my_role',
    'claim_student_session',
    'release_student_session',
    'assert_current_student_session',
    'get_student_exam_result',
    'get_db_size'
  ]) {
    const start = sql.indexOf(`FUNCTION public.${functionName}(`);
    assert.notEqual(start, -1, `${functionName} must be redefined`);
    const end = sql.indexOf('$function$;', start);
    const definition = sql.slice(start, end);
    assert.match(definition, /SET search_path = ''/);
  }

  assert.match(sql, /FROM public\.profiles AS p/);
  assert.match(sql, /FROM public\.students AS s/);
  assert.match(sql, /FROM public\.student_results AS r/);
  assert.match(sql, /FROM pg_catalog\.pg_class AS c/);
  assert.match(sql, /pg_catalog\.octet_length\(exam_id_param\)[\s\S]*128/);
  assert.match(sql, /s\.archived_at IS NULL/);
  assert.match(sql, /OPERATOR\(pg_catalog\.\=\)/);
});

test('Stage 21 indexes the unfiltered active-roster paging order', async () => {
  const sql = await readFile(rosterIndexMigrationUrl, 'utf8');
  assert.match(sql, /ON public\.students \(lower\(student_id\), id\)/);
  assert.match(sql, /WHERE archived_at IS NULL/);
});

test('Stage 21 corrects database routine volatility contracts reported by lint', async () => {
  const sql = await readFile(volatilityMigrationUrl, 'utf8');
  assert.match(sql, /sanitize_exam_responses\(jsonb, jsonb\) STABLE/);
  assert.match(sql, /exam_progress_to_submission\(jsonb, jsonb\) STABLE/);
  assert.match(sql, /normalize_submission_response_map\(jsonb, jsonb\) STABLE/);
  assert.match(sql, /admin_operational_health\(\) VOLATILE/);
});

test('Stage 21 bounds authoritative exam and asset workloads before expensive processing', async () => {
  const sql = await readFile(boundsMigrationUrl, 'utf8');

  assert.match(sql, /Exam payload must not exceed 8 MiB/);
  assert.match(sql, /no more than 500 questions/);
  assert.match(sql, /individual exam question must not exceed 64 KiB/);
  assert.match(sql, /validate_full_exam_paper_stage1_internal/);
  assert.match(sql, /octet_length\(asset_name\)[\s\S]*1024/);
  assert.match(sql, /LIMIT 500/);
  assert.match(sql, /supplied_count NOT BETWEEN 1 AND 100/);
  assert.match(sql, /cardinality\(normalized_names\)[\s\S]*supplied_count/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.assert_exam_payload_bounds\(jsonb\)/);
  assert.match(sql, /SET search_path = ''/);
});

test('Stage 21 removes raw papers from Realtime and publishes metadata only', async () => {
  const [sql, studentDashboard, preExam, adminDashboard] = await Promise.all([
    readFile(realtimeMigrationUrl, 'utf8'),
    readFile(new URL('../src/components/StudentDashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/PreExam.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8')
  ]);

  assert.match(sql, /ALTER PUBLICATION supabase_realtime DROP TABLE public\.cbt_exams_raw/);
  assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE public\.exam_status_events/);
  assert.match(sql, /CREATE TABLE public\.exam_status_events/);
  assert.doesNotMatch(sql.match(/CREATE TABLE public\.exam_status_events[\s\S]*?\);/)?.[0] || '', /questions_data|answers/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE public\.exam_status_events FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /SET search_path = ''/);

  for (const source of [studentDashboard, preExam, adminDashboard]) {
    assert.match(source, /table: 'exam_status_events'/);
    assert.doesNotMatch(source, /table: 'cbt_exams_raw'/);
  }
});

test('Stage 21 closes the search path on every remaining privileged routine', async () => {
  const sql = await readFile(remainingDefinersMigrationUrl, 'utf8');
  const alteredFunctions = [...sql.matchAll(/ALTER FUNCTION public\.([a-z0-9_]+)\([^;]*SET search_path = '';/g)]
    .map((match) => match[1]);

  assert.ok(alteredFunctions.length >= 31);
  for (const functionName of [
    'admin_import_questions',
    'admin_operational_health',
    'get_admin_exam_list_page',
    'get_admin_question_bank_page',
    'get_admin_student_roster_page',
    'get_unreferenced_exam_assets',
    'handle_cbt_exams_modification',
    'handle_new_user',
    'is_exam_asset_referenced',
    'preflight_validate_exam',
    'record_result_export',
    'validate_full_exam_paper'
  ]) {
    assert.ok(alteredFunctions.includes(functionName), `${functionName} must receive an empty search path`);
  }
});

test('Stage 21 exam authority functions are bounded, qualified, and search-path safe', async () => {
  const sql = await readFile(examMigrationUrl, 'utf8');

  for (const functionName of [
    'start_exam_session',
    'start_exam_session_stage3_internal',
    'sync_active_session_progress',
    'sync_active_session_progress_stage3_internal',
    'submit_exam',
    'submit_exam_stage3_internal',
    'terminate_exam',
    'terminate_exam_stage3_internal'
  ]) {
    const start = sql.indexOf(`FUNCTION public.${functionName}(`);
    assert.notEqual(start, -1, `${functionName} must be redefined`);
    const end = sql.indexOf('$function$;', start);
    assert.match(sql.slice(start, end), /SET search_path = ''/);
  }

  assert.equal((sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((sql.match(/^COMMIT;$/gm) || []).length, 1);
  assert.match(sql, /Response payload exceeds 256 KiB/);
  assert.match(sql, /Exam payload exceeds 8 MiB/);
  assert.match(sql, /FROM public\.cbt_exam_answers AS a/);
  assert.match(sql, /FROM public\.active_sessions AS s/);
  assert.match(sql, /public\.assert_current_student_session\(\)/);
  assert.match(sql, /OPERATOR\(pg_catalog\.\|\|\)/);
});
