-- A resumed session must not look valid after its server-side deadline.
CREATE OR REPLACE FUNCTION public.start_exam_session(
  exam_id_param uuid,
  exam_data_param jsonb,
  responses_param jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row public.cbt_exams_raw%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  duration_seconds integer;
  session_id text;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND OR exam_row.status <> 'ACTIVE' THEN RAISE EXCEPTION 'This exam is not available'; END IF;
  IF exam_row.class IS DISTINCT FROM student_row.class OR exam_row.section IS DISTINCT FROM student_row.section THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_results WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text) THEN
    RAISE EXCEPTION 'This exam has already been submitted';
  END IF;

  duration_seconds := GREATEST(COALESCE((exam_row.questions_data->>'duration')::integer, 180), 1) * 60;
  session_id := student_row.id::text || '_' || exam_id_param::text;
  SELECT * INTO session_row FROM public.active_sessions WHERE id = session_id;
  IF FOUND THEN
    IF session_row.started_at IS NULL OR clock_timestamp() > session_row.started_at + make_interval(secs => duration_seconds + 180) THEN
      PERFORM public.terminate_exam(exam_id_param);
      RAISE EXCEPTION 'This exam session has expired';
    END IF;
    RETURN jsonb_build_object('time_left', session_row.time_left, 'jumbled_exam_data', session_row.jumbled_exam_data, 'user_responses', session_row.user_responses);
  END IF;

  INSERT INTO public.active_sessions (id, student_id, exam_id, user_responses, jumbled_exam_data, time_left, started_at, updated_at)
  VALUES (session_id, student_row.student_id, exam_id_param::text, responses_param, exam_data_param, duration_seconds, now(), now());
  RETURN jsonb_build_object('time_left', duration_seconds, 'jumbled_exam_data', exam_data_param, 'user_responses', responses_param);
END;
$$;
