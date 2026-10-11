-- Bounded student reads and compatible saves; no papers or answers leave read RPCs.
BEGIN;

CREATE OR REPLACE FUNCTION public.student_dashboard_page(page_param integer DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  payload jsonb;
BEGIN
  PERFORM public.assert_current_student_session();
  IF page_param IS NULL OR page_param < 0 THEN
    RAISE EXCEPTION 'Dashboard page must be a non-negative integer' USING ERRCODE = '22023';
  END IF;
  SELECT s.* INTO student_row FROM public.students AS s WHERE s.id = auth.uid() AND s.archived_at IS NULL;

  WITH candidates AS MATERIALIZED (
    SELECT e.id, e.title, e.status, e.class, e.section, e.created_at
    FROM public.cbt_exams_raw AS e
    WHERE (e.class IS NULL OR e.class = 'All' OR e.class = student_row.class)
      AND (e.section IS NULL OR e.section = 'All' OR e.section = student_row.section)
    ORDER BY e.created_at DESC, e.id
    LIMIT 26 OFFSET page_param::bigint * 25
  ), page AS MATERIALIZED (
    SELECT * FROM candidates ORDER BY created_at DESC, id LIMIT 25
  ), cards AS (
    SELECT p.created_at, p.id, pg_catalog.jsonb_build_object(
      'id', p.id, 'title', p.title, 'status', p.status, 'class', p.class,
      'section', p.section, 'created_at', p.created_at,
      'questions_data', pg_catalog.jsonb_build_object(
        'duration', e.questions_data -> 'duration',
        'marksCorrect', e.questions_data -> 'marksCorrect',
        'marksIncorrect', e.questions_data -> 'marksIncorrect',
        'marking', e.questions_data -> 'marking',
        'subjects', e.questions_data -> 'subjects',
        'totalQuestions', e.questions_data -> 'totalQuestions'
      ),
      'result', CASE WHEN r.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
        'total_score', r.total_score, 'max_score', r.max_score, 'correct', r.correct,
        'partial', r.partial, 'incorrect', r.incorrect, 'unattempted', r.unattempted,
        'subject_scores', r.subject_scores
      ) END,
      'session', CASE WHEN s.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
        'id', s.id, 'exam_id', s.exam_id, 'status', s.status, 'deadline_at', s.deadline_at,
        'termination_reason', s.termination_reason, 'access_generation', s.access_generation
      ) END
    ) AS card
    FROM page AS p
    JOIN public.cbt_exams_raw AS e ON e.id = p.id
    LEFT JOIN public.student_results AS r ON r.exam_id = p.id::text AND r.student_id = student_row.student_id
    LEFT JOIN public.active_sessions AS s ON s.id = student_row.id::text || '_' || p.id::text
  )
  SELECT pg_catalog.jsonb_build_object(
    'exams', COALESCE((SELECT pg_catalog.jsonb_agg(card ORDER BY created_at DESC, id) FROM cards), '[]'::jsonb),
    'has_more', (SELECT count(*) > 25 FROM candidates),
    'server_now', pg_catalog.clock_timestamp()
  ) INTO payload;
  RETURN payload;
END;
$function$;

CREATE OR REPLACE FUNCTION public.student_exam_runtime(exam_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row record;
  payload jsonb;
BEGIN
  PERFORM public.assert_current_student_session();
  SELECT s.* INTO student_row FROM public.students AS s WHERE s.id = auth.uid() AND s.archived_at IS NULL;
  SELECT e.status, e.class, e.section INTO exam_row FROM public.cbt_exams_raw AS e WHERE e.id = exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This exam is not available' USING ERRCODE = 'EX007';
  END IF;
  IF (exam_row.class IS NULL OR exam_row.class = 'All' OR exam_row.class = student_row.class) IS NOT TRUE
    OR (exam_row.section IS NULL OR exam_row.section = 'All' OR exam_row.section = student_row.section) IS NOT TRUE
  THEN
    RAISE EXCEPTION 'This exam is not assigned to you' USING ERRCODE = 'EX006';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'exam_status', exam_row.status,
    'status', CASE WHEN r.id IS NOT NULL THEN 'SUBMITTED' ELSE s.status END,
    'deadline_at', s.deadline_at, 'termination_reason', s.termination_reason,
    'server_now', pg_catalog.clock_timestamp(),
    'time_left', CASE WHEN s.deadline_at IS NULL THEN 0 ELSE GREATEST(pg_catalog.ceil(
      EXTRACT(EPOCH FROM (s.deadline_at - pg_catalog.clock_timestamp())))::integer, 0) END,
    'version', s.version, 'access_generation', s.access_generation, 'session_owned', true,
    'result', CASE WHEN r.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'total_score', r.total_score, 'max_score', r.max_score, 'correct', r.correct,
      'partial', r.partial, 'incorrect', r.incorrect, 'unattempted', r.unattempted,
      'subject_scores', r.subject_scores
    ) END
  ) INTO payload
  FROM (SELECT 1) AS anchor
  LEFT JOIN public.active_sessions AS s ON s.id = student_row.id::text || '_' || exam_id_param::text
  LEFT JOIN public.student_results AS r ON r.student_id = student_row.student_id AND r.exam_id = exam_id_param::text;
  RETURN payload;
END;
$function$;

REVOKE ALL ON FUNCTION public.student_dashboard_page(integer), public.student_exam_runtime(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.student_dashboard_page(integer), public.student_exam_runtime(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.start_exam_session(exam_id_param uuid, exam_data_param jsonb, responses_param jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  started jsonb;
BEGIN
  IF exam_data_param IS NOT NULL AND pg_catalog.octet_length(exam_data_param::text) > 8388608 THEN
    RAISE EXCEPTION 'Exam payload exceeds 8 MiB';
  END IF;
  IF responses_param IS NOT NULL AND pg_catalog.octet_length(responses_param::text) > 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  started := public.start_exam_session_internal(exam_id_param, exam_data_param, responses_param);
  -- Existing expiry replies keep their camel-case grading result for old clients.
  RETURN public.student_exam_runtime(exam_id_param) || started;
END;
$function$;

DROP FUNCTION public.sync_active_session_progress(uuid, jsonb, integer, integer);
CREATE FUNCTION public.sync_active_session_progress(
  exam_id_param uuid,
  responses_param jsonb,
  expected_version_param integer,
  access_generation_param integer DEFAULT NULL,
  subject_time_seconds_param jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  saved jsonb;
  timing_saved boolean := false;
BEGIN
  IF responses_param IS NOT NULL AND pg_catalog.octet_length(responses_param::text) > 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  IF access_generation_param IS NULL OR access_generation_param < 1 THEN
    RAISE EXCEPTION 'A positive access generation is required' USING ERRCODE = 'EX015';
  END IF;
  saved := public.sync_active_session_progress_internal(exam_id_param, responses_param, expected_version_param, access_generation_param);
  IF (saved ->> 'success')::boolean AND subject_time_seconds_param IS NOT NULL THEN
    -- A rejected timing payload rolls back only timing, never confirmed answers.
    BEGIN
      PERFORM public.sync_exam_subject_time_internal(exam_id_param, subject_time_seconds_param, access_generation_param);
      timing_saved := true;
    EXCEPTION WHEN OTHERS THEN
      timing_saved := false;
    END;
  END IF;
  RETURN saved || public.student_exam_runtime(exam_id_param) || pg_catalog.jsonb_build_object('timing_saved', timing_saved);
END;
$function$;
REVOKE ALL ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer, integer, jsonb) TO authenticated, service_role;

-- Count all merged subjects so partial timing updates cannot bypass the elapsed limit.
CREATE OR REPLACE FUNCTION public.sync_exam_subject_time_internal(
  exam_id_param uuid,
  subject_time_seconds_param jsonb,
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_subjects pg_catalog.jsonb;
  session_duration pg_catalog.int4;
  subject_entry pg_catalog.record;
  merged_time pg_catalog.jsonb;
  submitted_seconds pg_catalog.int4;
  previous_seconds pg_catalog.int4;
  submitted_total pg_catalog.int8 := 0;
  elapsed_limit pg_catalog.int8;
  session_id text;
BEGIN
  IF exam_id_param IS NULL
    OR subject_time_seconds_param IS NULL
    OR pg_catalog.jsonb_typeof(subject_time_seconds_param) OPERATOR(pg_catalog.<>) 'object'
    OR pg_catalog.octet_length(subject_time_seconds_param::pg_catalog.text) OPERATOR(pg_catalog.>) 4096
  THEN
    RAISE EXCEPTION 'Invalid subject timing payload';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id || ':' || exam_id_param::text,
      0
    )
  );

  SELECT session.id, session.status, session.access_generation, session.subject_time_seconds, session.started_at,
         session.deadline_at,
         COALESCE(session.response_schema -> 'subjects', session.jumbled_exam_data -> 'subjects'),
         COALESCE((session.response_schema ->> 'duration'), (session.jumbled_exam_data ->> 'duration'))::pg_catalog.int4
  INTO session_row.id, session_row.status, session_row.access_generation, session_row.subject_time_seconds, session_row.started_at,
       session_row.deadline_at, session_subjects, session_duration
  FROM public.active_sessions AS session
  WHERE session.id OPERATOR(pg_catalog.=) session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted' USING ERRCODE = 'EX011';
  END IF;

  IF session_row.status = 'TERMINATED' THEN
    RAISE EXCEPTION 'Active session is terminated' USING ERRCODE = 'EX014';
  END IF;

  IF access_generation_param IS NOT NULL AND access_generation_param <> session_row.access_generation THEN
    RAISE EXCEPTION 'Session access generation mismatch' USING ERRCODE = 'EX015';
  END IF;

  IF session_row.deadline_at IS NULL OR pg_catalog.clock_timestamp() >= session_row.deadline_at THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved' USING ERRCODE = 'EX008';
  END IF;

  merged_time := COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb);
  FOR subject_entry IN
    SELECT entry.key, entry.value
    FROM pg_catalog.jsonb_each(subject_time_seconds_param) AS entry
  LOOP
    IF NOT COALESCE(session_subjects, '[]'::pg_catalog.jsonb)
      OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_array(subject_entry.key)
    THEN
      RAISE EXCEPTION 'Unknown examination subject';
    END IF;
    IF pg_catalog.jsonb_typeof(subject_entry.value) OPERATOR(pg_catalog.<>) 'number'
      OR subject_entry.value::pg_catalog.text !~ '^[0-9]+$'
    THEN
      RAISE EXCEPTION 'Subject time values must be whole non-negative seconds';
    END IF;
    submitted_seconds := subject_entry.value::pg_catalog.text::pg_catalog.int4;
    previous_seconds := COALESCE((merged_time ->> subject_entry.key)::pg_catalog.int4, 0);
    IF submitted_seconds OPERATOR(pg_catalog.<) previous_seconds THEN
      RAISE EXCEPTION 'Subject time cannot move backwards';
    END IF;
    merged_time := pg_catalog.jsonb_set(
      merged_time,
      ARRAY[subject_entry.key],
      pg_catalog.to_jsonb(submitted_seconds),
      true
    );
  END LOOP;

  SELECT COALESCE(sum(entry.value::text::bigint), 0) INTO submitted_total
  FROM pg_catalog.jsonb_each(merged_time) AS entry;

  elapsed_limit := LEAST(
    GREATEST(COALESCE(session_duration, 180), 1) * 60,
    GREATEST(pg_catalog.floor(EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - session_row.started_at)))::pg_catalog.int8, 0)
  ) OPERATOR(pg_catalog.+) 15;
  IF submitted_total OPERATOR(pg_catalog.>) elapsed_limit THEN
    RAISE EXCEPTION 'Subject timing exceeds the elapsed examination time';
  END IF;

  UPDATE public.active_sessions AS session
  SET subject_time_seconds = merged_time,
      updated_at = pg_catalog.clock_timestamp()
  WHERE session.id OPERATOR(pg_catalog.=) session_row.id;

  RETURN merged_time;
END;
$function$;

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
  oldest_expired_deadline timestamptz;
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
  SELECT count(*)::integer, min(deadline_at) INTO expired_session_count, oldest_expired_deadline
  FROM public.active_sessions WHERE deadline_at <= pg_catalog.clock_timestamp();
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
    'expired_sessions_oldest_deadline_at', oldest_expired_deadline,
    'database_size_bytes', pg_catalog.pg_database_size(pg_catalog.current_database()),
    'academic_storage_bytes', (
      SELECT sum(pg_catalog.pg_total_relation_size(relation))
      FROM unnest(ARRAY['public.cbt_exams_raw'::regclass, 'public.active_sessions'::regclass,
        'public.student_results'::regclass, 'public.admin_audit_events'::regclass]) AS relation
    ),
    'questions_missing_required_media', incomplete_media_count,
    'inactive_students', inactive_student_count,
    'audit_events_last_24_hours', recent_audit_count,
    'client_errors_last_hour', client_error_count,
    'scheduler', scheduler
  );
END;
$function$;

-- Guarded edits retain the full grading and server-owned paper routines while denying unknown assignments.
DO $assignment_guards$
DECLARE
  target record;
  function_definition text;
  replacement_fragment text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('public.start_exam_session_internal(uuid,jsonb,jsonb)'::pg_catalog.regprocedure, $assignment$  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class = 'All'
    OR exam_row.class = student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section = 'All'
    OR exam_row.section = student_row.section
  ) THEN
$assignment$),
      ('public.submit_exam_internal(uuid,jsonb,integer,integer)'::pg_catalog.regprocedure, $assignment$  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class OPERATOR(pg_catalog.=) 'All'
    OR exam_row.class OPERATOR(pg_catalog.=) student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section OPERATOR(pg_catalog.=) 'All'
    OR exam_row.section OPERATOR(pg_catalog.=) student_row.section
  ) THEN
$assignment$)
    ) AS guards(signature, expected_fragment)
  LOOP
    SELECT pg_catalog.pg_get_functiondef(target.signature) INTO function_definition;
    IF pg_catalog.length(function_definition) - pg_catalog.length(pg_catalog.replace(function_definition, target.expected_fragment, ''))
      <> pg_catalog.length(target.expected_fragment)
    THEN
      RAISE EXCEPTION 'Unexpected assignment guard in %', target.signature;
    END IF;
    replacement_fragment := pg_catalog.replace(target.expected_fragment, '  IF NOT (', '  IF (');
    replacement_fragment := pg_catalog.replace(replacement_fragment, '  ) OR NOT (', '  ) IS NOT TRUE OR (');
    replacement_fragment := pg_catalog.replace(replacement_fragment, '  ) THEN', '  ) IS NOT TRUE THEN');
    EXECUTE pg_catalog.replace(function_definition, target.expected_fragment, replacement_fragment);
  END LOOP;
END;
$assignment_guards$;

-- Before expiry, submission must grade the exact snapshot the caller confirmed.
DO $submission_version_guard$
DECLARE
  function_definition text;
  expected_fragment text := '  session_was_terminated := (session_row.status = ''TERMINATED'');';
  replacement_fragment text := $guard$  IF expected_version_param IS NOT NULL
    AND pg_catalog.clock_timestamp() < session_row.deadline_at
    AND expected_version_param <> session_row.version
  THEN
    RAISE EXCEPTION 'Exam session version conflict; confirm the current saved answers before submitting' USING ERRCODE = 'EX013';
  END IF;

  session_was_terminated := (session_row.status = 'TERMINATED');$guard$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef('public.submit_exam_internal(uuid,jsonb,integer,integer)'::pg_catalog.regprocedure)
  INTO function_definition;
  IF pg_catalog.length(function_definition) - pg_catalog.length(pg_catalog.replace(function_definition, expected_fragment, ''))
    <> pg_catalog.length(expected_fragment)
  THEN
    RAISE EXCEPTION 'Unexpected submit_exam_internal version guard location';
  END IF;
  EXECUTE pg_catalog.replace(function_definition, expected_fragment, replacement_fragment);
END;
$submission_version_guard$;

COMMIT;
