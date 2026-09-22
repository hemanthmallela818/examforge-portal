-- Root-only, independently scoped cleanup actions. Student accounts and
-- administrator records are intentionally never touched by these routines.

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
  DELETE FROM public.student_results;
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
  DELETE FROM public.cbt_exam_answers;
  DELETE FROM public.exam_status_events;
  DELETE FROM public.cbt_exams_raw;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN EXECUTE 'DELETE FROM public.exams'; END IF;
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
  DELETE FROM public.question_bank;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_QUESTION_BANK', 'question_bank', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count, 'asset_disposition', 'retained_for_exam_snapshot_safety'));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_clear_scoped_data_for_actor(
  actor_id_param uuid, target_param text, confirmation_param text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner WHERE owner.user_id = actor_id_param
  ) THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF target_param NOT IN ('student_results', 'cbt_exams', 'question_bank') THEN
    RAISE EXCEPTION 'Unsupported scoped cleanup target';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  IF target_param = 'student_results' THEN RETURN public.root_clear_results(confirmation_param); END IF;
  IF target_param = 'cbt_exams' THEN RETURN public.root_clear_exams(confirmation_param); END IF;
  RETURN public.root_clear_questions(confirmation_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.root_clear_results(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_exams(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_questions(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_scoped_data_for_actor(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.root_clear_scoped_data_for_actor(uuid, text, text) TO service_role;
