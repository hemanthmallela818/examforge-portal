BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;

SET LOCAL session_replication_role = replica;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-stage21@example.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000011', 'authenticated', 'authenticated', 'student1-stage21@example.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000012', 'authenticated', 'authenticated', 'student2-stage21@example.invalid', now(), now()),
  ('00000000-0000-0000-0000-000000000013', 'authenticated', 'authenticated', 'archived-stage21@example.invalid', now(), now());

INSERT INTO public.profiles (id, email, name, role)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin-stage21@example.invalid', 'Stage 21 Admin', 'admin'),
  ('00000000-0000-0000-0000-000000000011', 'student1-stage21@example.invalid', 'Student One', 'student'),
  ('00000000-0000-0000-0000-000000000012', 'student2-stage21@example.invalid', 'Student Two', 'student'),
  ('00000000-0000-0000-0000-000000000013', 'archived-stage21@example.invalid', 'Archived Student', 'student');

INSERT INTO public.classes (id, name, sections)
VALUES
  ('30000000-0000-0000-0000-000000000001', 'Class A', ARRAY['Section 1']),
  ('30000000-0000-0000-0000-000000000002', 'Class B', ARRAY['Section 2']);

INSERT INTO public.students (
  id, student_id, name, class, section, active_auth_session_id,
  archived_at, archived_by, archive_reason
)
VALUES
  ('00000000-0000-0000-0000-000000000011', 'S001', 'Student One', 'Class A', 'Section 1', '20000000-0000-0000-0000-000000000011', NULL, NULL, NULL),
  ('00000000-0000-0000-0000-000000000012', 'S002', 'Student Two', 'Class B', 'Section 2', '20000000-0000-0000-0000-000000000012', NULL, NULL, NULL),
  ('00000000-0000-0000-0000-000000000013', 'S003', 'Archived Student', 'Class A', 'Section 1', NULL, now(), '00000000-0000-0000-0000-000000000001', 'Archived for Stage 21 testing');

INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section)
VALUES
  (
    '10000000-0000-0000-0000-000000000001', 'Assigned active exam', 'ACTIVE',
    '{"subjects":["Physics"],"questions":{"Physics":[{"id":"q1","text":"Private prompt one","type":"MCQ","options":["A","B","C","D"]}]},"duration":60,"marksCorrect":4,"marksIncorrect":-1}',
    'Class A', 'Section 1'
  ),
  (
    '10000000-0000-0000-0000-000000000002', 'Assigned pending exam', 'PENDING',
    '{"subjects":["Physics"],"questions":{"Physics":[{"id":"q2","text":"Private prompt two","type":"MCQ","options":["A","B","C","D"]}]},"duration":60,"marksCorrect":4,"marksIncorrect":-1}',
    'Class A', 'Section 1'
  ),
  (
    '10000000-0000-0000-0000-000000000003', 'Other class exam', 'ACTIVE',
    '{"subjects":["Physics"],"questions":{"Physics":[{"id":"q3","text":"Private prompt three","type":"MCQ","options":["A","B","C","D"]}]},"duration":60,"marksCorrect":4,"marksIncorrect":-1}',
    'Class B', 'Section 2'
  );

INSERT INTO public.cbt_exam_answers (exam_id, answers)
VALUES
  ('10000000-0000-0000-0000-000000000001', '{"q1":{"correct_answer":"0","subject":"Physics","type":"MCQ"}}'),
  ('10000000-0000-0000-0000-000000000002', '{"q2":{"correct_answer":"1","subject":"Physics","type":"MCQ"}}'),
  ('10000000-0000-0000-0000-000000000003', '{"q3":{"correct_answer":"2","subject":"Physics","type":"MCQ"}}');

INSERT INTO public.exam_status_events (exam_id, title, status, class, section)
SELECT id, title, status, class, section FROM public.cbt_exams_raw;

INSERT INTO public.active_sessions (
  id, student_id, exam_id, user_responses, jumbled_exam_data,
  time_left, started_at, deadline_at, version
)
VALUES (
  '00000000-0000-0000-0000-000000000011_10000000-0000-0000-0000-000000000001',
  'S001', '10000000-0000-0000-0000-000000000001', '{}',
  '{"subjects":["Physics"],"questions":{"Physics":[{"id":"q1","text":"Private prompt one","type":"MCQ","options":["A","B","C","D"]}]},"duration":60,"marksCorrect":4,"marksIncorrect":-1}',
  3600, now(), now() + interval '1 hour', 1
);

INSERT INTO public.student_results (
  exam_id, student_id, student_name, total_score, max_score,
  correct, incorrect, unattempted, subject_scores
)
VALUES
  ('10000000-0000-0000-0000-000000000001', 'S001', 'Student One', 4, 4, 1, 0, 0, '{"Physics":4}'),
  ('10000000-0000-0000-0000-000000000003', 'S002', 'Student Two', 0, 4, 0, 1, 0, '{"Physics":0}');

INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
VALUES ('00000000-0000-0000-0000-000000000001', 'STAGE21_TEST', 'test', 'stage21', '{}');

SET LOCAL session_replication_role = origin;

SELECT plan(30);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'p')
      AND has_any_column_privilege('anon', c.oid, 'SELECT')
  ),
  'anonymous has no SELECT privilege on any public relation'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ),
  'anonymous cannot execute any public function'
);

SELECT ok(
  NOT has_schema_privilege('anon', 'public', 'CREATE')
  AND NOT has_schema_privilege('authenticated', 'public', 'CREATE'),
  'browser roles cannot create objects in public'
);

SELECT set_eq(
  $$SELECT column_name FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'students'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'$$,
  $$VALUES ('id'), ('student_id'), ('name'), ('class'), ('section'),
           ('created_at'), ('active_auth_session_id'), ('archived_at')$$,
  'student roster exposes only the reviewed safe columns'
);

SELECT ok(
  NOT has_column_privilege('authenticated', 'public.students', 'archived_by', 'SELECT')
  AND NOT has_column_privilege('authenticated', 'public.students', 'archive_reason', 'SELECT'),
  'student lifecycle audit metadata is not directly readable'
);

SELECT set_eq(
  $$SELECT column_name FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'cbt_exams_raw'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'$$,
  $$VALUES ('id'), ('title'), ('status'), ('class'), ('section'), ('created_at')$$,
  'raw exams expose metadata columns only'
);

SELECT ok(
  NOT has_column_privilege('authenticated', 'public.cbt_exams_raw', 'questions_data', 'SELECT')
  AND NOT has_any_column_privilege('authenticated', 'public.cbt_exam_answers', 'SELECT'),
  'raw questions and answer keys are not directly readable'
);

SELECT is(
  (SELECT reloptions FROM pg_class WHERE oid = 'public.cbt_exams'::regclass),
  ARRAY['security_invoker=true']::text[],
  'the exam API view runs with caller permissions'
);

SELECT is(
  (
    SELECT count(*)
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  ),
  0::bigint,
  'every public base table has RLS enabled'
);

WITH expected(name, args) AS (
  VALUES
    ('admin_clear_question_bank', 'confirmation_param text'),
    ('admin_deactivate_students', 'user_ids_param uuid[], reason_param text'),
    ('admin_delete_empty_class', 'class_id_param uuid, expected_name_param text'),
    ('admin_delete_question', 'question_id_param uuid'),
    ('admin_delete_unused_exam', 'exam_id_param uuid, expected_title_param text'),
    ('admin_finalize_expired_sessions', 'batch_limit_param integer'),
    ('admin_import_questions', 'batch_id_param uuid, file_name_param text, questions_param jsonb'),
    ('admin_operational_health', ''),
    ('admin_reactivate_students', 'user_ids_param uuid[]'),
    ('admin_update_student_assignment', 'student_user_id_param uuid, class_name_param text, section_param text'),
    ('claim_student_session', ''),
    ('current_auth_session_id', ''),
    ('exam_questions_for_viewer', 'p_exam_id uuid'),
    ('get_admin_exam_list_page', 'page_number_param integer, page_size_param integer, search_param text, status_param text'),
    ('get_admin_exam_results_export_page', 'exam_id_param uuid, after_student_id_param text, page_size_param integer, expected_result_count_param integer'),
    ('get_admin_exam_results_page', 'exam_id_param uuid, page_number_param integer, page_size_param integer, search_param text, expected_result_count_param integer'),
    ('get_admin_question_bank_page', 'page_number_param integer, page_size_param integer, search_param text, subject_param text, type_param text'),
    ('get_admin_questions_by_ids', 'question_ids_param uuid[]'),
    ('get_admin_student_roster_page', 'page_number_param integer, page_size_param integer, search_param text, class_param text, section_param text'),
    ('get_db_size', ''),
    ('get_my_role', ''),
    ('get_student_exam_result', 'exam_id_param text'),
    ('get_unreferenced_exam_assets', ''),
    ('is_admin_aal2', ''),
    ('is_exam_asset_referenced', 'asset_name text'),
    ('preflight_validate_exam', 'exam_id_param uuid'),
    ('record_exam_asset_cleanup', 'asset_names text[]'),
    ('record_result_export', 'exam_id_param uuid, export_format_param text, expected_result_count_param integer'),
    ('release_student_session', ''),
    ('start_exam_session', 'uuid, jsonb, jsonb'),
    ('submit_exam', 'uuid, jsonb'),
    ('sync_active_session_progress', 'uuid, jsonb, integer'),
    ('terminate_exam', 'uuid')
), actual AS (
  SELECT p.proname::text AS name,
    pg_get_function_identity_arguments(p.oid)::text AS args
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
), differences AS (
  (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  UNION ALL
  (SELECT * FROM expected EXCEPT SELECT * FROM actual)
)
SELECT ok(NOT EXISTS (SELECT 1 FROM differences),
  'authenticated function execution exactly matches the reviewed allowlist');

SELECT is(
  (
    SELECT count(*)
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND coalesce(array_to_string(p.proconfig, ','), '')
        <> ('search_path=' || chr(34) || chr(34))
  ),
  0::bigint,
  'every public SECURITY DEFINER function has an empty search path'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'cbt_exams_raw'
  ),
  'raw exam papers are absent from Realtime'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'exam_status_events'
  ),
  'metadata-only exam status events are in Realtime'
);

SELECT set_eq(
  $$SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'exam_status_events'$$,
  $$VALUES ('exam_id'), ('title'), ('status'), ('class'), ('section'), ('changed_at')$$,
  'Realtime exam events contain no paper or answer fields'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'exam-assets'
      AND public = false
      AND file_size_limit = 5242880
      AND allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']::text[]
  ),
  'exam-assets is private and restricted by size and MIME type'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_default_acl AS d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
    WHERE d.defaclrole = 'postgres'::regrole
      AND d.defaclnamespace = 'public'::regnamespace
      AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)
  ),
  'future postgres-owned public objects are private from browser roles by default'
);

SELECT ok(
  NOT has_function_privilege('authenticated', 'public.reconstruct_exam_questions(jsonb,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.submit_exam_stage3_internal(uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.validate_full_exam_paper(text,jsonb)', 'EXECUTE'),
  'reconstruction, grading internals, provisioning, and validators are not browser-callable'
);

SELECT ok(
  NOT has_any_column_privilege('authenticated', 'public.exam_status_events', 'INSERT')
  AND NOT has_any_column_privilege('authenticated', 'public.exam_status_events', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.exam_status_events', 'DELETE'),
  'browser roles cannot forge exam Realtime events'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.cbt_exams', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.classes', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.question_bank', 'DELETE'),
  'exam, class, and question deletion is restricted to audited RPCs'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'v', 'm', 'p')
      AND NOT (
        has_table_privilege('service_role', c.oid, 'SELECT')
        AND has_table_privilege('service_role', c.oid, 'INSERT')
        AND has_table_privilege('service_role', c.oid, 'UPDATE')
        AND has_table_privilege('service_role', c.oid, 'DELETE')
      )
  ),
  'service role has explicit full access to every current public relation'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
  ),
  'service role can execute every current public routine'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND NOT pg_catalog.has_sequence_privilege(
        'service_role',
        pg_catalog.quote_ident(n.nspname) || '.' || pg_catalog.quote_ident(c.relname),
        'USAGE'
      )
  ),
  'service role has explicit access to every current public sequence'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated","aal":"aal1","session_id":"20000000-0000-0000-0000-000000000011"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT is((SELECT count(*) FROM public.cbt_exams_raw), 2::bigint,
  'student sees assigned raw-exam metadata but not another class');
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.cbt_exams
    WHERE questions_data ? 'questions'
  ),
  'student exam view never discloses question arrays before start'
);
SELECT is((SELECT count(*) FROM public.active_sessions), 1::bigint,
  'student sees only the active session owned by the current auth session');
SELECT is((SELECT count(*) FROM public.student_results), 1::bigint,
  'student sees only their own result');

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1","session_id":"20000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  public.is_admin_aal2() = false
  AND (SELECT count(*) FROM public.admin_audit_events) = 0
  AND (SELECT count(*) FROM public.cbt_exams_raw) = 0,
  'AAL1 administrator receives no administrative database access'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal2","session_id":"20000000-0000-0000-0000-000000000001"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  public.is_admin_aal2()
  AND (SELECT count(*) FROM public.cbt_exams_raw) = 3
  AND (SELECT count(*) FROM public.admin_audit_events) = 1,
  'AAL2 administrator receives the reviewed administrative read surface'
);
SELECT ok(
  ((public.get_admin_student_roster_page(0, 20, '', '', '') ->> 'total')::integer = 3),
  'AAL2 roster RPC executes successfully with bounded paging'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000013","role":"authenticated","aal":"aal1","session_id":"20000000-0000-0000-0000-000000000013"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT count(*) FROM public.students) = 0
  AND (SELECT count(*) FROM public.cbt_exams_raw) = 0
  AND (SELECT count(*) FROM public.student_results) = 0,
  'archived student cannot retrieve roster, exam, or result rows'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
