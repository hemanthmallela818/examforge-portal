-- Serialize submissions for one student/exam and return the committed result.

CREATE OR REPLACE FUNCTION public.submit_exam(exam_id_param uuid, responses_param jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  result_row public.student_results%ROWTYPE;
  answers_obj jsonb;
  response_map jsonb;
  answer_entry record;
  answer_data jsonb;
  response_data jsonb;
  marks_correct numeric;
  marks_incorrect numeric;
  total_score numeric := 0;
  correct_count integer := 0;
  incorrect_count integer := 0;
  unattempted_count integer := 0;
  total_questions integer := 0;
  subject_scores jsonb := '{}'::jsonb;
  subject_name text;
  is_attempted boolean;
  is_correct boolean;
  user_val numeric;
  correct_val numeric;
  max_seconds integer;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;
  IF FOUND THEN
    RETURN jsonb_build_object('totalScore', result_row.total_score, 'maxScore', result_row.max_score,
      'correct', result_row.correct, 'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted, 'subjectScores', result_row.subject_scores);
  END IF;

  IF jsonb_typeof(COALESCE(responses_param, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Invalid response payload';
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND OR exam_row.status NOT IN ('ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'This exam is not available for submission';
  END IF;
  IF NOT (exam_row.class IS NULL OR exam_row.class = 'All' OR exam_row.class = student_row.class)
     OR NOT (exam_row.section IS NULL OR exam_row.section = 'All' OR exam_row.section = student_row.section) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  SELECT * INTO session_row FROM public.active_sessions
  WHERE id = student_row.id::text || '_' || exam_id_param::text;
  IF NOT FOUND OR session_row.started_at IS NULL THEN
    RAISE EXCEPTION 'Exam session was not started correctly';
  END IF;

  max_seconds := GREATEST(COALESCE((exam_row.questions_data->>'duration')::integer, 180), 1) * 60 + 180;
  IF clock_timestamp() > session_row.started_at + make_interval(secs => max_seconds) THEN
    PERFORM public.terminate_exam(exam_id_param);
    SELECT * INTO result_row FROM public.student_results
    WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;
    RETURN jsonb_build_object('totalScore', result_row.total_score, 'maxScore', result_row.max_score,
      'correct', result_row.correct, 'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted, 'subjectScores', result_row.subject_scores);
  END IF;

  SELECT answers INTO answers_obj FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  IF answers_obj IS NULL THEN RAISE EXCEPTION 'Answer key not found'; END IF;

  SELECT COALESCE(jsonb_object_agg(item->>'question_id', item), '{}'::jsonb)
  INTO response_map
  FROM jsonb_array_elements(responses_param) AS item
  WHERE jsonb_typeof(item) = 'object' AND item ? 'question_id';

  marks_correct := COALESCE((exam_row.questions_data->>'marksCorrect')::numeric, 4);
  marks_incorrect := COALESCE((exam_row.questions_data->>'marksIncorrect')::numeric, -1);

  FOR answer_entry IN SELECT key, value FROM jsonb_each(answers_obj) LOOP
    total_questions := total_questions + 1;
    answer_data := answer_entry.value;
    response_data := COALESCE(response_map->answer_entry.key, '{}'::jsonb);
    subject_name := COALESCE(NULLIF(answer_data->>'subject', ''), 'General');
    subject_scores := jsonb_set(subject_scores, ARRAY[subject_name],
      COALESCE(subject_scores->subject_name, '0'::jsonb), true);
    is_attempted := response_data->>'status' IN ('ANSWERED', 'ANSWERED_MARKED')
      AND response_data->'selected_option' IS NOT NULL AND response_data->>'selected_option' <> '';
    is_correct := false;

    IF is_attempted THEN
      IF upper(COALESCE(answer_data->>'type', 'MCQ')) IN ('NUMERICAL', 'NAT') THEN
        BEGIN
          user_val := (response_data->>'selected_option')::numeric;
          correct_val := (answer_data->>'correct_answer')::numeric;
          is_correct := abs(user_val - correct_val) < 0.00001;
        EXCEPTION WHEN OTHERS THEN
          is_correct := trim(lower(response_data->>'selected_option')) = trim(lower(answer_data->>'correct_answer'));
        END;
      ELSE
        is_correct := response_data->>'selected_option' = answer_data->>'correct_answer';
      END IF;
    END IF;

    IF NOT is_attempted THEN
      unattempted_count := unattempted_count + 1;
    ELSIF is_correct THEN
      correct_count := correct_count + 1;
      total_score := total_score + marks_correct;
      subject_scores := jsonb_set(subject_scores, ARRAY[subject_name],
        to_jsonb(COALESCE((subject_scores->>subject_name)::numeric, 0) + marks_correct), true);
    ELSE
      incorrect_count := incorrect_count + 1;
      total_score := total_score + marks_incorrect;
      subject_scores := jsonb_set(subject_scores, ARRAY[subject_name],
        to_jsonb(COALESCE((subject_scores->>subject_name)::numeric, 0) + marks_incorrect), true);
    END IF;
  END LOOP;

  INSERT INTO public.student_results (exam_id, student_id, student_name, total_score, max_score,
    correct, incorrect, unattempted, subject_scores, submitted_at)
  VALUES (exam_id_param::text, student_row.student_id, student_row.name, total_score,
    total_questions * marks_correct, correct_count, incorrect_count, unattempted_count, subject_scores, now())
  ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions WHERE id = session_row.id;
  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;

  RETURN jsonb_build_object('totalScore', result_row.total_score, 'maxScore', result_row.max_score,
    'correct', result_row.correct, 'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted, 'subjectScores', result_row.subject_scores);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_exam(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb) TO authenticated;
