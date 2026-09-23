-- PostgREST API sessions enable the safe-update guard, which requires every
-- DELETE to include an explicit predicate. These routines intentionally clear
-- their complete, root-authorized scope, so WHERE true documents that intent
-- while remaining compatible with the hosted API session.

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
    EXECUTE 'DELETE FROM public.proctor_flags WHERE true';
  END IF;
  IF pg_catalog.to_regclass('public.attempts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.attempts WHERE true';
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.questions WHERE true';
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.exams WHERE true';
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.live_feeds WHERE true';
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

CREATE OR REPLACE FUNCTION public.root_clear_results(confirmation_param text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE deleted_count bigint;
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR EXAM RESULTS' THEN RAISE EXCEPTION 'Exact results confirmation is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(2026092211);
  LOCK TABLE public.student_results IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO deleted_count FROM public.student_results;
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  DELETE FROM public.student_results WHERE true;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_EXAM_RESULTS', 'student_results', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_clear_exams(confirmation_param text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE deleted_count bigint; result_count bigint; session_count bigint;
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
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN EXECUTE 'DELETE FROM public.exams WHERE true'; END IF;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_EXAMS', 'cbt_exams', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_clear_questions(confirmation_param text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE deleted_count bigint;
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR QUESTION BANK' THEN RAISE EXCEPTION 'Exact question-bank confirmation is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(2026092211);
  LOCK TABLE public.question_bank IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO deleted_count FROM public.question_bank;
  DELETE FROM public.question_bank WHERE true;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_QUESTION_BANK', 'question_bank', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count, 'asset_disposition', 'retained_for_exam_snapshot_safety'));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.root_reset_application_data(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_results(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_exams(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_questions(text) FROM PUBLIC, anon, authenticated;
