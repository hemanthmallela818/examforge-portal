-- C18: self-hosted client error reporting and alert signals.
--
-- Browser errors (already redacted and de-duplicated by src/runtimeDiagnostics.js)
-- are recorded through record_client_error(). The function is rate limited per
-- user, stores only short, capped fields (never answers, tokens or payloads), and
-- the table has no direct grants. Administrators read it through
-- admin_recent_client_errors(), and admin_operational_health() reports the
-- last-hour count so the scheduled health check can alert on spikes.

BEGIN;

CREATE TABLE public.client_error_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  role text CHECK (role IS NULL OR length(role) <= 20),
  context text NOT NULL CHECK (length(context) BETWEEN 1 AND 120),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
  code text CHECK (code IS NULL OR length(code) <= 60),
  status integer CHECK (status IS NULL OR status BETWEEN 0 AND 999),
  incident_id text CHECK (incident_id IS NULL OR length(incident_id) <= 80),
  path text CHECK (path IS NULL OR length(path) <= 200)
);
CREATE INDEX client_error_events_occurred_idx ON public.client_error_events (occurred_at DESC);
CREATE INDEX client_error_events_user_recent_idx ON public.client_error_events (user_id, occurred_at DESC);

ALTER TABLE public.client_error_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.client_error_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.client_error_events TO service_role;

CREATE OR REPLACE FUNCTION public.record_client_error(report_param jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller uuid := auth.uid();
  caller_role text;
  clip text;
BEGIN
  IF caller IS NULL THEN RETURN false; END IF;
  IF report_param IS NULL OR pg_catalog.jsonb_typeof(report_param) <> 'object'
     OR pg_catalog.octet_length(report_param::text) > 4096 THEN
    RETURN false;
  END IF;
  -- At most 20 reports per user per 10 minutes; excess reports are dropped.
  IF (SELECT count(*) FROM public.client_error_events AS e
      WHERE e.user_id = caller AND e.occurred_at > pg_catalog.clock_timestamp() - interval '10 minutes') >= 20 THEN
    RETURN false;
  END IF;

  SELECT p.role INTO caller_role FROM public.profiles AS p WHERE p.id = caller;

  INSERT INTO public.client_error_events (user_id, role, context, name, message, code, status, incident_id, path)
  VALUES (
    caller,
    left(caller_role, 20),
    COALESCE(NULLIF(left(btrim(report_param ->> 'context'), 120), ''), 'runtime'),
    COALESCE(NULLIF(left(btrim(report_param ->> 'name'), 120), ''), 'Error'),
    COALESCE(NULLIF(left(btrim(report_param ->> 'message'), 500), ''), 'Unknown client error'),
    NULLIF(left(btrim(report_param ->> 'code'), 60), ''),
    CASE WHEN (report_param ->> 'status') ~ '^[0-9]{1,3}$' THEN (report_param ->> 'status')::integer END,
    NULLIF(left(btrim(report_param ->> 'incidentId'), 80), ''),
    NULLIF(left(btrim(report_param ->> 'path'), 200), '')
  );
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_client_error(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_client_error(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_recent_client_errors(limit_param integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access is required' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'occurredAt', e.occurred_at, 'role', e.role, 'context', e.context, 'name', e.name,
      'message', e.message, 'code', e.code, 'status', e.status, 'incidentId', e.incident_id, 'path', e.path
    ) ORDER BY e.occurred_at DESC)
    FROM (
      SELECT * FROM public.client_error_events
      ORDER BY occurred_at DESC
      LIMIT LEAST(GREATEST(COALESCE(limit_param, 50), 1), 200)
    ) AS e
  ), '[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.admin_recent_client_errors(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_recent_client_errors(integer) TO authenticated;

-- 30-day retention, run by the scheduler (and callable by the service role).
CREATE OR REPLACE FUNCTION public.purge_old_client_errors()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH removed AS (
    DELETE FROM public.client_error_events
    WHERE occurred_at < pg_catalog.clock_timestamp() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*)::integer FROM removed;
$function$;
REVOKE ALL ON FUNCTION public.purge_old_client_errors() FROM PUBLIC, anon, authenticated;

-- Health now includes the client error rate (ATTENTION above 25 in the last hour).
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
  client_error_count integer;
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
  SELECT count(*)::integer INTO client_error_count FROM public.client_error_events
  WHERE occurred_at >= pg_catalog.clock_timestamp() - interval '1 hour';

  SELECT count(*)::integer INTO incomplete_media_count
  FROM public.question_bank
  WHERE has_image_or_diagram = true AND length(btrim(COALESCE(question_image_url, ''))) = 0;

  scheduler := public.exam_scheduler_health();

  RETURN jsonb_build_object(
    'status', CASE
      WHEN expired_session_count > 0 OR incomplete_media_count > 0 OR client_error_count > 25
        OR NOT COALESCE((scheduler ->> 'healthy')::boolean, true)
        THEN 'ATTENTION' ELSE 'HEALTHY' END,
    'checked_at', pg_catalog.clock_timestamp(),
    'active_exams', active_exam_count,
    'live_sessions', live_session_count,
    'expired_sessions_pending_finalization', expired_session_count,
    'questions_missing_required_media', incomplete_media_count,
    'inactive_students', inactive_student_count,
    'audit_events_last_24_hours', recent_audit_count,
    'client_errors_last_hour', client_error_count,
    'scheduler', scheduler
  );
END;
$function$;

COMMIT;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('examforge-purge-client-errors', '17 3 * * *', 'SELECT public.purge_old_client_errors()');
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not schedule client error retention (%).', SQLERRM;
END;
$cron$;
