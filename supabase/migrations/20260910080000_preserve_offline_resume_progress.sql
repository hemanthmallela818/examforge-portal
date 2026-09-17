-- Preserve newer offline progress when an existing server-owned session resumes.
-- The question paper and deadline remain server-owned.

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
  remaining_seconds integer;
  session_id text;
  subject_name text;
  shuffled_questions jsonb := '{}'::jsonb;
  shuffled_subject jsonb;
  server_exam_data jsonb;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND OR exam_row.status <> 'ACTIVE' THEN RAISE EXCEPTION 'This exam is not available'; END IF;
  IF NOT (exam_row.class IS NULL OR exam_row.class = 'All' OR exam_row.class = student_row.class)
     OR NOT (exam_row.section IS NULL OR exam_row.section = 'All' OR exam_row.section = student_row.section) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_results WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text) THEN
    RAISE EXCEPTION 'This exam has already been submitted';
  END IF;

  duration_seconds := GREATEST(COALESCE((exam_row.questions_data->>'duration')::integer, 180), 1) * 60;
  session_id := student_row.id::text || '_' || exam_id_param::text;
  SELECT * INTO session_row FROM public.active_sessions WHERE id = session_id;
  IF FOUND THEN
    remaining_seconds := duration_seconds - FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - session_row.started_at)))::integer;
    IF session_row.started_at IS NULL OR remaining_seconds < -180 THEN
      PERFORM public.terminate_exam(exam_id_param);
      RETURN jsonb_build_object('expired', true);
    END IF;
    IF responses_param IS NOT NULL AND jsonb_typeof(responses_param) = 'object' THEN
      UPDATE public.active_sessions
      SET user_responses = responses_param, updated_at = now()
      WHERE id = session_id;
      session_row.user_responses := responses_param;
    END IF;
    RETURN jsonb_build_object(
      'time_left', GREATEST(remaining_seconds, 0),
      'jumbled_exam_data', session_row.jumbled_exam_data,
      'user_responses', session_row.user_responses
    );
  END IF;

  IF jsonb_typeof(exam_row.questions_data->'questions') <> 'object' THEN
    RAISE EXCEPTION 'Exam question data is invalid';
  END IF;

  FOR subject_name IN SELECT jsonb_object_keys(exam_row.questions_data->'questions') LOOP
    SELECT COALESCE(jsonb_agg(question ORDER BY random()), '[]'::jsonb)
    INTO shuffled_subject
    FROM jsonb_array_elements(exam_row.questions_data->'questions'->subject_name) AS question;
    shuffled_questions := jsonb_set(shuffled_questions, ARRAY[subject_name], shuffled_subject, true);
  END LOOP;
  server_exam_data := jsonb_set(exam_row.questions_data, '{questions}', shuffled_questions, true);

  INSERT INTO public.active_sessions
    (id, student_id, exam_id, user_responses, jumbled_exam_data, time_left, started_at, updated_at)
  VALUES
    (session_id, student_row.student_id, exam_id_param::text, responses_param, server_exam_data, duration_seconds, now(), now());

  RETURN jsonb_build_object(
    'time_left', duration_seconds,
    'jumbled_exam_data', server_exam_data,
    'user_responses', responses_param
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) TO authenticated;
