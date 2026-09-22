-- Root-only reusable-environment reset. This intentionally preserves Auth and
-- application records for the root developer and managed administrators.

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
    EXECUTE 'SELECT count(*) FROM public.attempts' INTO legacy_attempts;
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.exams' INTO legacy_exams;
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.questions' INTO legacy_questions;
  END IF;
  IF pg_catalog.to_regclass('public.proctor_flags') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.proctor_flags' INTO legacy_proctor_flags;
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.live_feeds' INTO legacy_live_feeds;
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

  -- Serialize resets and take stable counts before any destructive work.
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

  -- Older hosted projects may still contain these unused prototype tables.
  IF pg_catalog.to_regclass('public.proctor_flags') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.proctor_flags';
  END IF;
  IF pg_catalog.to_regclass('public.attempts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.attempts';
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.questions';
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.exams';
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.live_feeds';
  END IF;

  DELETE FROM public.active_sessions;
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  DELETE FROM public.student_results;
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers;
  DELETE FROM public.cbt_exams_raw;
  DELETE FROM public.exam_status_events;
  DELETE FROM public.question_import_batches;
  DELETE FROM public.import_history;
  DELETE FROM public.question_bank;
  DELETE FROM public.students;
  DELETE FROM public.classes;
  DELETE FROM public.admin_audit_events;

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

REVOKE ALL ON FUNCTION public.root_application_reset_preview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.root_reset_application_data(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.root_application_reset_preview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.root_reset_application_data(text) TO authenticated;
