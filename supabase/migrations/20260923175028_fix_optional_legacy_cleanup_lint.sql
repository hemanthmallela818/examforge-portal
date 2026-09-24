-- Keep support for prototype tables that may exist on upgraded hosted projects
-- without making plpgsql_check resolve absent optional relations on clean installs.

CREATE OR REPLACE FUNCTION public.root_count_optional_legacy_table(table_name_param text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  row_count bigint;
BEGIN
  IF table_name_param NOT IN ('attempts', 'exams', 'questions', 'proctor_flags', 'live_feeds') THEN
    RAISE EXCEPTION 'Unsupported legacy table';
  END IF;
  EXECUTE pg_catalog.format('SELECT count(*) FROM %I.%I', 'public', table_name_param) INTO row_count;
  RETURN row_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_delete_optional_legacy_table(table_name_param text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF table_name_param NOT IN ('attempts', 'exams', 'questions', 'proctor_flags', 'live_feeds') THEN
    RAISE EXCEPTION 'Unsupported legacy table';
  END IF;
  EXECUTE pg_catalog.format('DELETE FROM %I.%I WHERE true', 'public', table_name_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.root_count_optional_legacy_table(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_delete_optional_legacy_table(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.root_application_reset_preview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  counts jsonb;
  legacy_attempts bigint := 0;
  legacy_exams bigint := 0;
  legacy_questions bigint := 0;
  legacy_proctor_flags bigint := 0;
  legacy_live_feeds bigint := 0;
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;

  IF pg_catalog.to_regclass('public.attempts') IS NOT NULL THEN
    legacy_attempts := public.root_count_optional_legacy_table('attempts');
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    legacy_exams := public.root_count_optional_legacy_table('exams');
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    legacy_questions := public.root_count_optional_legacy_table('questions');
  END IF;
  IF pg_catalog.to_regclass('public.proctor_flags') IS NOT NULL THEN
    legacy_proctor_flags := public.root_count_optional_legacy_table('proctor_flags');
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    legacy_live_feeds := public.root_count_optional_legacy_table('live_feeds');
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'student_accounts', (
      SELECT pg_catalog.count(*)
      FROM public.profiles AS p
      WHERE p.role IS DISTINCT FROM 'admin'
        AND NOT EXISTS (SELECT 1 FROM public.application_owner AS owner WHERE owner.user_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM public.managed_administrators AS managed WHERE managed.user_id = p.id)
    ),
    'students', (SELECT pg_catalog.count(*) FROM public.students),
    'classes', (SELECT pg_catalog.count(*) FROM public.classes),
    'exams', (SELECT pg_catalog.count(*) FROM public.cbt_exams_raw),
    'active_sessions', (SELECT pg_catalog.count(*) FROM public.active_sessions),
    'results', (SELECT pg_catalog.count(*) FROM public.student_results),
    'questions', (SELECT pg_catalog.count(*) FROM public.question_bank),
    'import_history', (SELECT pg_catalog.count(*) FROM public.import_history),
    'import_batches', (SELECT pg_catalog.count(*) FROM public.question_import_batches),
    'audit_events', (SELECT pg_catalog.count(*) FROM public.admin_audit_events),
    'legacy_attempts', legacy_attempts,
    'legacy_exams', legacy_exams,
    'legacy_questions', legacy_questions,
    'legacy_proctor_flags', legacy_proctor_flags,
    'legacy_live_feeds', legacy_live_feeds
  ) INTO counts;

  RETURN counts;
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_reset_application_data(confirmation_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  counts jsonb;
  student_user_ids uuid[];
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  IF confirmation_param IS DISTINCT FROM 'RESET APPLICATION DATA' THEN
    RAISE EXCEPTION 'Exact reset confirmation is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(2026092205);
  counts := public.root_application_reset_preview();

  SELECT pg_catalog.array_agg(p.id ORDER BY p.id)
  INTO student_user_ids
  FROM public.profiles AS p
  WHERE p.role IS DISTINCT FROM 'admin'
    AND NOT EXISTS (SELECT 1 FROM public.application_owner AS owner WHERE owner.user_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.managed_administrators AS managed WHERE managed.user_id = p.id);

  LOCK TABLE
    public.active_sessions,
    public.student_results,
    public.cbt_exam_answers,
    public.cbt_exams_raw,
    public.exam_status_events,
    public.question_import_batches,
    public.import_history,
    public.question_bank,
    public.students,
    public.classes,
    public.admin_audit_events
  IN ACCESS EXCLUSIVE MODE;

  IF pg_catalog.to_regclass('public.proctor_flags') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('proctor_flags');
  END IF;
  IF pg_catalog.to_regclass('public.attempts') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('attempts');
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('questions');
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('exams');
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('live_feeds');
  END IF;

  DELETE FROM public.active_sessions WHERE true;
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  DELETE FROM public.student_results WHERE true;
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers WHERE true;
  DELETE FROM public.cbt_exams_raw WHERE true;
  DELETE FROM public.exam_status_events WHERE true;
  DELETE FROM public.question_import_batches WHERE true;
  DELETE FROM public.import_history WHERE true;
  DELETE FROM public.question_bank WHERE true;
  DELETE FROM public.students WHERE true;
  DELETE FROM public.classes WHERE true;
  DELETE FROM public.admin_audit_events WHERE true;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    actor_id,
    'RESET_APPLICATION_DATA',
    'application',
    NULL,
    pg_catalog.jsonb_build_object('deleted', counts, 'preserved', 'root_and_administrator_accounts')
  );

  RETURN pg_catalog.jsonb_build_object(
    'deleted', counts,
    'auth_user_ids', pg_catalog.to_jsonb(COALESCE(student_user_ids, ARRAY[]::uuid[]))
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_clear_exams(confirmation_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  deleted_count bigint;
  result_count bigint;
  session_count bigint;
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR EXAMS' THEN RAISE EXCEPTION 'Exact exams confirmation is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(2026092211);
  SELECT count(*) INTO result_count FROM public.student_results;
  SELECT count(*) INTO session_count FROM public.active_sessions;
  IF result_count > 0 OR session_count > 0 THEN
    RAISE EXCEPTION 'Clear exam results and active student sessions first';
  END IF;
  LOCK TABLE public.cbt_exam_answers, public.cbt_exams_raw, public.exam_status_events IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO deleted_count FROM public.cbt_exams_raw;
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers WHERE true;
  DELETE FROM public.exam_status_events WHERE true;
  DELETE FROM public.cbt_exams_raw WHERE true;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('exams');
  END IF;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_EXAMS', 'cbt_exams', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$function$;
