-- Stage 7B: read-only operational health summary for AAL2 administrators.

CREATE OR REPLACE FUNCTION public.admin_operational_health()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  active_exam_count integer;
  live_session_count integer;
  expired_session_count integer;
  incomplete_media_count integer;
  inactive_student_count integer;
  recent_audit_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  SELECT count(*)::integer INTO active_exam_count FROM public.cbt_exams_raw WHERE status = 'ACTIVE';
  SELECT count(*)::integer INTO live_session_count FROM public.active_sessions WHERE deadline_at > clock_timestamp();
  SELECT count(*)::integer INTO expired_session_count FROM public.active_sessions WHERE deadline_at <= clock_timestamp();
  SELECT count(*)::integer INTO inactive_student_count FROM public.students WHERE archived_at IS NOT NULL;
  SELECT count(*)::integer INTO recent_audit_count FROM public.admin_audit_events WHERE occurred_at >= clock_timestamp() - interval '24 hours';

  SELECT count(*)::integer INTO incomplete_media_count
  FROM public.question_bank
  WHERE has_image_or_diagram = true AND length(btrim(COALESCE(question_image_url, ''))) = 0;

  RETURN jsonb_build_object(
    'status', CASE WHEN expired_session_count > 0 OR incomplete_media_count > 0 THEN 'ATTENTION' ELSE 'HEALTHY' END,
    'checked_at', clock_timestamp(),
    'active_exams', active_exam_count,
    'live_sessions', live_session_count,
    'expired_sessions_pending_finalization', expired_session_count,
    'questions_missing_required_media', incomplete_media_count,
    'inactive_students', inactive_student_count,
    'audit_events_last_24_hours', recent_audit_count
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_operational_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_operational_health() TO authenticated;
