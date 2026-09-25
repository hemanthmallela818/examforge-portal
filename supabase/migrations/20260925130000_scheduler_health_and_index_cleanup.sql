-- Backend tidy-ups from the code review.
--
-- 1. Drop two indexes that are fully covered by composite indexes (they only
--    cost writes on every result insert):
--      student_results_exam_id_idx    (exam_id)    <- student_results_exam_student_idx (exam_id, student_id)
--      student_results_student_id_idx (student_id) <- student_results_student_exam_key (student_id, exam_id)
-- 2. admin_operational_health() now reports the pg_cron finalizer: last run,
--    last status and recent failures. Overall status becomes ATTENTION when the
--    scheduler is failing or has not succeeded for 5 minutes. Works (reports
--    "unavailable") where pg_cron is not installed.

BEGIN;

DROP INDEX IF EXISTS public.student_results_exam_id_idx;
DROP INDEX IF EXISTS public.student_results_student_id_idx;

CREATE OR REPLACE FUNCTION public.exam_scheduler_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  job_id bigint;
  last_run record;
  last_success timestamptz;
  recent_failures integer;
BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL OR pg_catalog.to_regclass('cron.job_run_details') IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('available', false, 'healthy', true,
      'message', 'pg_cron is not installed; expired attempts are finalized by administrators only.');
  END IF;

  EXECUTE 'SELECT jobid FROM cron.job WHERE jobname = $1' INTO job_id USING 'examforge-finalize-expired-sessions';
  IF job_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('available', true, 'scheduled', false, 'healthy', false,
      'message', 'The finalizer job is not scheduled.');
  END IF;

  EXECUTE 'SELECT status, start_time, left(COALESCE(return_message, ''''), 200) AS message
           FROM cron.job_run_details WHERE jobid = $1 ORDER BY start_time DESC LIMIT 1'
    INTO last_run USING job_id;
  EXECUTE 'SELECT max(start_time) FROM cron.job_run_details WHERE jobid = $1 AND status = ''succeeded'''
    INTO last_success USING job_id;
  EXECUTE 'SELECT count(*)::integer FROM cron.job_run_details
           WHERE jobid = $1 AND status = ''failed'' AND start_time >= pg_catalog.clock_timestamp() - interval ''1 hour'''
    INTO recent_failures USING job_id;

  RETURN pg_catalog.jsonb_build_object(
    'available', true,
    'scheduled', true,
    'last_run_at', last_run.start_time,
    'last_status', last_run.status,
    'last_message', CASE WHEN last_run.status = 'failed' THEN last_run.message END,
    'last_success_at', last_success,
    'failures_last_hour', COALESCE(recent_failures, 0),
    'healthy', last_run.status IS NULL
      OR (last_run.status <> 'failed'
          AND last_success IS NOT NULL
          AND last_success >= pg_catalog.clock_timestamp() - interval '5 minutes')
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.exam_scheduler_health() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_operational_health()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  active_exam_count integer;
  live_session_count integer;
  expired_session_count integer;
  incomplete_media_count integer;
  inactive_student_count integer;
  recent_audit_count integer;
  scheduler jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access is required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO active_exam_count FROM public.cbt_exams_raw WHERE status = 'ACTIVE';
  SELECT count(*)::integer INTO live_session_count FROM public.active_sessions WHERE deadline_at > pg_catalog.clock_timestamp();
  SELECT count(*)::integer INTO expired_session_count FROM public.active_sessions WHERE deadline_at <= pg_catalog.clock_timestamp();
  SELECT count(*)::integer INTO inactive_student_count FROM public.students WHERE archived_at IS NOT NULL;
  SELECT count(*)::integer INTO recent_audit_count FROM public.admin_audit_events
  WHERE occurred_at >= pg_catalog.clock_timestamp() - interval '24 hours';

  SELECT count(*)::integer INTO incomplete_media_count
  FROM public.question_bank
  WHERE has_image_or_diagram = true AND length(btrim(COALESCE(question_image_url, ''))) = 0;

  scheduler := public.exam_scheduler_health();

  RETURN jsonb_build_object(
    'status', CASE
      WHEN expired_session_count > 0 OR incomplete_media_count > 0 OR NOT COALESCE((scheduler ->> 'healthy')::boolean, true)
        THEN 'ATTENTION' ELSE 'HEALTHY' END,
    'checked_at', pg_catalog.clock_timestamp(),
    'active_exams', active_exam_count,
    'live_sessions', live_session_count,
    'expired_sessions_pending_finalization', expired_session_count,
    'questions_missing_required_media', incomplete_media_count,
    'inactive_students', inactive_student_count,
    'audit_events_last_24_hours', recent_audit_count,
    'scheduler', scheduler
  );
END;
$function$;

COMMIT;
