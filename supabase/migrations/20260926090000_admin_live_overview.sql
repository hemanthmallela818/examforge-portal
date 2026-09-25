-- Read-only snapshot for the administrator Dashboard Overview (U6).
--
-- get_admin_live_overview(recent_limit_param) returns, in one round trip:
--   * live_exams: every ACTIVE exam with its class/section, when it went live,
--     duration, question count, students writing now (unexpired sessions),
--     expired attempts awaiting finalization, submitted results, the number of
--     non-archived students assigned to it and the latest live deadline;
--   * totals: students writing now and expired attempts awaiting finalization
--     across all exams;
--   * recent_results: the most recent submitted results (score, exam, time).
--
-- No answers, responses or question content are returned. Administrator
-- (AAL2) only; the function never writes.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_admin_live_overview(recent_limit_param integer DEFAULT 5)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  now_at timestamptz := pg_catalog.clock_timestamp();
  recent_limit integer := LEAST(GREATEST(COALESCE(recent_limit_param, 5), 0), 20);
  live_exams jsonb;
  recent_results jsonb;
  writing_total integer;
  pending_total integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access is required' USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::integer INTO writing_total FROM public.active_sessions WHERE deadline_at > now_at;
  SELECT count(*)::integer INTO pending_total FROM public.active_sessions WHERE deadline_at <= now_at;

  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY (item ->> 'activated_at') DESC NULLS LAST, item ->> 'id'), '[]'::jsonb)
  INTO live_exams
  FROM (
    SELECT pg_catalog.jsonb_build_object(
      'id', exam.id,
      'title', exam.title,
      'class', exam.class,
      'section', exam.section,
      'created_at', exam.created_at,
      'activated_at', status_event.changed_at,
      'duration', CASE WHEN COALESCE(exam.questions_data ->> 'duration', '') ~ '^[0-9]+$'
        THEN (exam.questions_data ->> 'duration')::integer END,
      'total_questions', CASE WHEN COALESCE(exam.questions_data ->> 'totalQuestions', '') ~ '^[0-9]+$'
        THEN (exam.questions_data ->> 'totalQuestions')::integer END,
      'writing', COALESCE(sessions.writing, 0),
      'awaiting_finalization', COALESCE(sessions.expired, 0),
      'latest_deadline_at', sessions.latest_deadline_at,
      'submitted', COALESCE(results.submitted, 0),
      'assigned_students', COALESCE(roster.assigned, 0)
    ) AS item
    FROM public.cbt_exams_raw AS exam
    LEFT JOIN public.exam_status_events AS status_event
      ON status_event.exam_id = exam.id AND status_event.status = 'ACTIVE'
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE session.deadline_at > now_at)::integer AS writing,
        count(*) FILTER (WHERE session.deadline_at <= now_at)::integer AS expired,
        max(session.deadline_at) FILTER (WHERE session.deadline_at > now_at) AS latest_deadline_at
      FROM public.active_sessions AS session
      WHERE session.exam_id = exam.id::text
    ) AS sessions ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS submitted
      FROM public.student_results AS result
      WHERE result.exam_id = exam.id::text
    ) AS results ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS assigned
      FROM public.students AS student
      WHERE student.archived_at IS NULL
        AND (exam.class IS NULL OR exam.class = 'All' OR student.class = exam.class)
        AND (exam.section IS NULL OR exam.section = 'All' OR student.section = exam.section)
    ) AS roster ON true
    WHERE exam.status = 'ACTIVE'
  ) AS live;

  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY (item ->> 'submitted_at') DESC, item ->> 'id'), '[]'::jsonb)
  INTO recent_results
  FROM (
    SELECT pg_catalog.jsonb_build_object(
      'id', result.id,
      'exam_id', result.exam_id,
      'exam_title', exam.title,
      'student_id', result.student_id,
      'student_name', result.student_name,
      'total_score', result.total_score,
      'max_score', result.max_score,
      'submitted_at', result.submitted_at
    ) AS item
    FROM public.student_results AS result
    LEFT JOIN public.cbt_exams_raw AS exam ON exam.id::text = result.exam_id
    ORDER BY result.submitted_at DESC, result.id
    LIMIT recent_limit
  ) AS recent;

  RETURN pg_catalog.jsonb_build_object(
    'checked_at', now_at,
    'students_writing', writing_total,
    'awaiting_finalization', pending_total,
    'live_exams', live_exams,
    'recent_results', recent_results
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_live_overview(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_live_overview(integer) TO authenticated;

COMMIT;
