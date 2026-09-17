-- Stage 3A: close deadline, concurrency, lifecycle, and pre-start paper leaks.
-- Forward-only: every earlier migration remains immutable.

ALTER TABLE public.active_sessions
  ADD COLUMN IF NOT EXISTS deadline_at timestamp with time zone;

-- Candidate progress is RPC-only.  AAL2 administrators and service_role retain
-- their existing operational paths; candidates cannot mutate session rows.
REVOKE ALL ON public.active_sessions FROM anon;
REVOKE ALL ON public.active_sessions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.active_sessions TO authenticated;

DROP POLICY IF EXISTS active_sessions_update_progress ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_admin_update ON public.active_sessions;
CREATE POLICY active_sessions_admin_update ON public.active_sessions
  FOR UPDATE TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- Validate and canonicalize positional progress against the server paper.
CREATE OR REPLACE FUNCTION public.sanitize_exam_responses(
  raw_responses jsonb,
  paper_questions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  subject_name text;
  raw_subject jsonb;
  cleaned_subject jsonb;
  cleaned jsonb := '{}'::jsonb;
  response_item jsonb;
  question_item jsonb;
  selected_value jsonb;
  selected_text text;
  status_value text;
  question_type text;
  paper_length integer;
  raw_length integer;
  option_index integer;
  idx integer;
BEGIN
  raw_responses := COALESCE(raw_responses, '{}'::jsonb);
  IF jsonb_typeof(raw_responses) <> 'object' THEN
    RAISE EXCEPTION 'Invalid progress payload: expected an object';
  END IF;
  IF octet_length(raw_responses::text) > 262144 THEN
    RAISE EXCEPTION 'Progress payload exceeds 256 KiB';
  END IF;
  IF paper_questions IS NULL OR jsonb_typeof(paper_questions) <> 'object' THEN
    RAISE EXCEPTION 'Invalid server exam paper';
  END IF;

  FOR subject_name IN SELECT jsonb_object_keys(raw_responses) LOOP
    IF NOT (paper_questions ? subject_name) THEN
      RAISE EXCEPTION 'Unknown response subject: %', subject_name;
    END IF;
  END LOOP;

  FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
    IF jsonb_typeof(paper_questions->subject_name) <> 'array' THEN
      RAISE EXCEPTION 'Invalid server question list for subject %', subject_name;
    END IF;
    paper_length := jsonb_array_length(paper_questions->subject_name);
    raw_subject := raw_responses->subject_name;
    IF raw_subject IS NULL THEN
      raw_subject := '[]'::jsonb;
    ELSIF jsonb_typeof(raw_subject) <> 'array' THEN
      RAISE EXCEPTION 'Invalid response list for subject %', subject_name;
    END IF;
    raw_length := jsonb_array_length(raw_subject);
    IF raw_length > paper_length THEN
      RAISE EXCEPTION 'Too many responses for subject %', subject_name;
    END IF;

    cleaned_subject := '[]'::jsonb;
    IF paper_length > 0 THEN
      FOR idx IN 0..paper_length - 1 LOOP
        question_item := paper_questions->subject_name->idx;
        response_item := CASE WHEN idx < raw_length THEN raw_subject->idx ELSE NULL END;

        IF response_item IS NULL OR jsonb_typeof(response_item) = 'null' THEN
          response_item := jsonb_build_object('selectedOption', NULL, 'status', 'NOT_VISITED');
        ELSIF jsonb_typeof(response_item) <> 'object' THEN
          RAISE EXCEPTION 'Invalid response at %.%', subject_name, idx;
        END IF;

        IF EXISTS (
          SELECT 1 FROM jsonb_object_keys(response_item) AS response_key(key_name)
          WHERE key_name NOT IN ('selectedOption', 'status')
        ) THEN
          RAISE EXCEPTION 'Unexpected response field at %.%', subject_name, idx;
        END IF;

        status_value := COALESCE(response_item->>'status', 'NOT_VISITED');
        IF status_value NOT IN ('NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED') THEN
          RAISE EXCEPTION 'Invalid response status at %.%', subject_name, idx;
        END IF;

        selected_value := response_item->'selectedOption';
        IF selected_value IS NULL OR jsonb_typeof(selected_value) = 'null' THEN
          selected_value := 'null'::jsonb;
          selected_text := NULL;
        ELSIF jsonb_typeof(selected_value) NOT IN ('string', 'number') THEN
          RAISE EXCEPTION 'Invalid selected option type at %.%', subject_name, idx;
        ELSE
          selected_text := selected_value #>> '{}';
        END IF;

        IF status_value IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NULL THEN
          RAISE EXCEPTION 'Answered response has no selected option at %.%', subject_name, idx;
        END IF;
        IF status_value NOT IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NOT NULL THEN
          RAISE EXCEPTION 'Unanswered response contains a selected option at %.%', subject_name, idx;
        END IF;

        IF selected_text IS NOT NULL THEN
          question_type := upper(COALESCE(question_item->>'type', 'MCQ'));
          IF question_type IN ('NUMERICAL', 'NAT') THEN
            IF length(selected_text) > 64
               OR selected_text !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
              RAISE EXCEPTION 'Invalid numerical response at %.%', subject_name, idx;
            END IF;
          ELSE
            IF selected_text !~ '^[0-9]+$' THEN
              RAISE EXCEPTION 'Invalid MCQ option at %.%', subject_name, idx;
            END IF;
            option_index := selected_text::integer;
            IF jsonb_typeof(question_item->'options') <> 'array'
               OR option_index < 0
               OR option_index >= jsonb_array_length(question_item->'options') THEN
              RAISE EXCEPTION 'MCQ option is out of range at %.%', subject_name, idx;
            END IF;
          END IF;
        END IF;

        cleaned_subject := cleaned_subject || jsonb_build_array(jsonb_build_object(
          'selectedOption', selected_value,
          'status', status_value
        ));
      END LOOP;
    END IF;
    cleaned := jsonb_set(cleaned, ARRAY[subject_name], cleaned_subject, true);
  END LOOP;

  RETURN cleaned;
END;
$$;

REVOKE ALL ON FUNCTION public.sanitize_exam_responses(jsonb, jsonb) FROM PUBLIC;

-- Convert canonical positional progress to the question-id submission shape.
CREATE OR REPLACE FUNCTION public.exam_progress_to_submission(
  progress jsonb,
  paper_questions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  canonical jsonb;
  output jsonb := '[]'::jsonb;
  subject_name text;
  question_item jsonb;
  response_item jsonb;
  idx integer;
BEGIN
  canonical := public.sanitize_exam_responses(progress, paper_questions);
  FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
    idx := 0;
    FOR question_item IN SELECT value FROM jsonb_array_elements(paper_questions->subject_name) LOOP
      response_item := canonical->subject_name->idx;
      output := output || jsonb_build_array(jsonb_build_object(
        'question_id', question_item->>'id',
        'selected_option', response_item->'selectedOption',
        'status', response_item->>'status'
      ));
      idx := idx + 1;
    END LOOP;
  END LOOP;
  RETURN output;
END;
$$;

REVOKE ALL ON FUNCTION public.exam_progress_to_submission(jsonb, jsonb) FROM PUBLIC;

-- Strictly validate a client submission and return a unique question-id map.
CREATE OR REPLACE FUNCTION public.normalize_submission_response_map(
  raw_responses jsonb,
  paper_questions jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  valid_questions jsonb := '{}'::jsonb;
  response_map jsonb := '{}'::jsonb;
  subject_name text;
  question_item jsonb;
  response_item jsonb;
  selected_value jsonb;
  selected_text text;
  status_value text;
  question_type text;
  question_id text;
  question_count integer := 0;
  option_index integer;
BEGIN
  raw_responses := COALESCE(raw_responses, '[]'::jsonb);
  IF jsonb_typeof(raw_responses) <> 'array' THEN
    RAISE EXCEPTION 'Invalid response payload: expected an array';
  END IF;
  IF octet_length(raw_responses::text) > 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  IF paper_questions IS NULL OR jsonb_typeof(paper_questions) <> 'object' THEN
    RAISE EXCEPTION 'Invalid server exam paper';
  END IF;

  FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
    IF jsonb_typeof(paper_questions->subject_name) <> 'array' THEN
      RAISE EXCEPTION 'Invalid server question list for subject %', subject_name;
    END IF;
    FOR question_item IN SELECT value FROM jsonb_array_elements(paper_questions->subject_name) LOOP
      question_id := question_item->>'id';
      IF question_id IS NULL OR question_id = '' OR valid_questions ? question_id THEN
        RAISE EXCEPTION 'Invalid or duplicate question ID in server paper';
      END IF;
      valid_questions := jsonb_set(valid_questions, ARRAY[question_id], question_item, true);
      question_count := question_count + 1;
    END LOOP;
  END LOOP;

  IF jsonb_array_length(raw_responses) > question_count THEN
    RAISE EXCEPTION 'Response count exceeds exam question count';
  END IF;

  FOR response_item IN SELECT value FROM jsonb_array_elements(raw_responses) LOOP
    IF jsonb_typeof(response_item) <> 'object' THEN
      RAISE EXCEPTION 'Invalid response entry';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(response_item) AS response_key(key_name)
      WHERE key_name NOT IN ('question_id', 'selected_option', 'status')
    ) THEN
      RAISE EXCEPTION 'Unexpected response field';
    END IF;

    question_id := response_item->>'question_id';
    IF question_id IS NULL OR question_id = '' OR NOT (valid_questions ? question_id) THEN
      RAISE EXCEPTION 'Unknown question ID';
    END IF;
    IF response_map ? question_id THEN
      RAISE EXCEPTION 'Duplicate question ID in response payload';
    END IF;

    status_value := COALESCE(response_item->>'status', 'NOT_VISITED');
    IF status_value NOT IN ('NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED') THEN
      RAISE EXCEPTION 'Invalid response status';
    END IF;

    selected_value := response_item->'selected_option';
    IF selected_value IS NULL OR jsonb_typeof(selected_value) = 'null' THEN
      selected_value := 'null'::jsonb;
      selected_text := NULL;
    ELSIF jsonb_typeof(selected_value) NOT IN ('string', 'number') THEN
      RAISE EXCEPTION 'Invalid selected option type';
    ELSE
      selected_text := selected_value #>> '{}';
    END IF;

    IF status_value IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NULL THEN
      RAISE EXCEPTION 'Answered response has no selected option';
    END IF;
    IF status_value NOT IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NOT NULL THEN
      RAISE EXCEPTION 'Unanswered response contains a selected option';
    END IF;

    question_item := valid_questions->question_id;
    IF selected_text IS NOT NULL THEN
      question_type := upper(COALESCE(question_item->>'type', 'MCQ'));
      IF question_type IN ('NUMERICAL', 'NAT') THEN
        IF length(selected_text) > 64
           OR selected_text !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
          RAISE EXCEPTION 'Invalid numerical response';
        END IF;
      ELSE
        IF selected_text !~ '^[0-9]+$' THEN
          RAISE EXCEPTION 'Invalid MCQ option';
        END IF;
        option_index := selected_text::integer;
        IF jsonb_typeof(question_item->'options') <> 'array'
           OR option_index < 0
           OR option_index >= jsonb_array_length(question_item->'options') THEN
          RAISE EXCEPTION 'MCQ option is out of range';
        END IF;
      END IF;
    END IF;

    response_map := jsonb_set(response_map, ARRAY[question_id], jsonb_build_object(
      'question_id', question_id,
      'selected_option', selected_value,
      'status', status_value
    ), true);
  END LOOP;

  RETURN response_map;
END;
$$;

REVOKE ALL ON FUNCTION public.normalize_submission_response_map(jsonb, jsonb) FROM PUBLIC;

-- Backfill immutable deadlines and canonicalize any pre-existing sessions.  A
-- malformed legacy row deliberately stops the migration instead of silently
-- carrying corrupt exam state into production.
UPDATE public.active_sessions
SET deadline_at = started_at + make_interval(
      secs => GREATEST(COALESCE((jumbled_exam_data->>'duration')::integer, 180), 1) * 60
    )
WHERE deadline_at IS NULL AND started_at IS NOT NULL;

UPDATE public.active_sessions
SET user_responses = public.sanitize_exam_responses(
  COALESCE(user_responses, '{}'::jsonb),
  jumbled_exam_data->'questions'
)
WHERE jumbled_exam_data IS NOT NULL;

CREATE OR REPLACE FUNCTION public.start_exam_session(
  exam_id_param uuid,
  exam_data_param jsonb,
  responses_param jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  initial_responses jsonb;
  start_time timestamp with time zone;
  final_result jsonb;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'This exam is not available'; END IF;

  IF NOT (exam_row.class IS NULL OR exam_row.class = 'All' OR exam_row.class = student_row.class)
     OR NOT (exam_row.section IS NULL OR exam_row.section = 'All' OR exam_row.section = student_row.section) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.student_results
    WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text
  ) THEN
    RAISE EXCEPTION 'This exam has already been submitted';
  END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;
  SELECT * INTO session_row FROM public.active_sessions WHERE id = session_id;

  IF FOUND THEN
    IF exam_row.status NOT IN ('ACTIVE', 'ENDED') OR session_row.started_at IS NULL THEN
      RAISE EXCEPTION 'This exam session is not available';
    END IF;
    IF session_row.deadline_at IS NULL THEN
      duration_seconds := GREATEST(COALESCE((session_row.jumbled_exam_data->>'duration')::integer, 180), 1) * 60;
      UPDATE public.active_sessions
      SET deadline_at = session_row.started_at + make_interval(secs => duration_seconds)
      WHERE id = session_id
      RETURNING * INTO session_row;
    END IF;

    IF clock_timestamp() >= session_row.deadline_at THEN
      final_result := public.submit_exam(exam_id_param, '[]'::jsonb);
      RETURN jsonb_build_object('expired', true, 'time_left', 0, 'result', final_result);
    END IF;

    remaining_seconds := GREATEST(
      CEIL(EXTRACT(EPOCH FROM (session_row.deadline_at - clock_timestamp())))::integer,
      0
    );
    RETURN jsonb_build_object(
      'time_left', remaining_seconds,
      'started_at', session_row.started_at,
      'deadline_at', session_row.deadline_at,
      'jumbled_exam_data', session_row.jumbled_exam_data,
      'user_responses', session_row.user_responses,
      'version', session_row.version
    );
  END IF;

  IF exam_row.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'This exam is not available';
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
  initial_responses := public.sanitize_exam_responses('{}'::jsonb, server_exam_data->'questions');
  duration_seconds := GREATEST(COALESCE((server_exam_data->>'duration')::integer, 180), 1) * 60;
  start_time := clock_timestamp();

  INSERT INTO public.active_sessions
    (id, student_id, exam_id, user_responses, jumbled_exam_data, time_left,
     started_at, deadline_at, updated_at, version)
  VALUES
    (session_id, student_row.student_id, exam_id_param::text, initial_responses,
     server_exam_data, duration_seconds, start_time,
     start_time + make_interval(secs => duration_seconds), start_time, 1)
  RETURNING * INTO session_row;

  RETURN jsonb_build_object(
    'time_left', duration_seconds,
    'started_at', session_row.started_at,
    'deadline_at', session_row.deadline_at,
    'jumbled_exam_data', session_row.jumbled_exam_data,
    'user_responses', session_row.user_responses,
    'version', session_row.version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_active_session_progress(
  exam_id_param uuid,
  responses_param jsonb,
  expected_version_param integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_id text;
  canonical_responses jsonb;
  new_version integer;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;
  IF expected_version_param IS NULL OR expected_version_param < 1 THEN
    RAISE EXCEPTION 'A positive expected session version is required';
  END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));
  SELECT * INTO session_row FROM public.active_sessions WHERE id = session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active session not found or already submitted'; END IF;

  IF expected_version_param <> session_row.version THEN
    RETURN jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'user_responses', session_row.user_responses
    );
  END IF;
  IF session_row.deadline_at IS NULL OR clock_timestamp() >= session_row.deadline_at THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved';
  END IF;

  canonical_responses := public.sanitize_exam_responses(
    responses_param,
    session_row.jumbled_exam_data->'questions'
  );
  new_version := session_row.version + 1;
  UPDATE public.active_sessions
  SET user_responses = canonical_responses,
      updated_at = clock_timestamp(),
      version = new_version
  WHERE id = session_id;

  RETURN jsonb_build_object(
    'success', true,
    'conflict', false,
    'version', new_version,
    'saved_at', clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_exam(exam_id_param uuid, responses_param jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  result_row public.student_results%ROWTYPE;
  answers_obj jsonb;
  response_map jsonb;
  server_submission jsonb;
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
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'totalScore', result_row.total_score, 'maxScore', result_row.max_score,
      'correct', result_row.correct, 'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted, 'subjectScores', result_row.subject_scores
    );
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
  IF NOT FOUND OR session_row.started_at IS NULL OR session_row.deadline_at IS NULL THEN
    RAISE EXCEPTION 'Exam session was not started correctly';
  END IF;
  IF responses_param IS NOT NULL AND octet_length(responses_param::text) > 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  -- Empty submissions and every request at/after the strict deadline grade the
  -- last server-confirmed snapshot.  The grace period is delivery-only.
  IF clock_timestamp() >= session_row.deadline_at
     OR responses_param IS NULL
     OR (jsonb_typeof(responses_param) = 'array' AND jsonb_array_length(responses_param) = 0) THEN
    server_submission := public.exam_progress_to_submission(
      session_row.user_responses,
      session_row.jumbled_exam_data->'questions'
    );
    response_map := public.normalize_submission_response_map(
      server_submission,
      session_row.jumbled_exam_data->'questions'
    );
  ELSE
    response_map := public.normalize_submission_response_map(
      responses_param,
      session_row.jumbled_exam_data->'questions'
    );
  END IF;

  SELECT answers INTO answers_obj FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  IF answers_obj IS NULL THEN RAISE EXCEPTION 'Answer key not found'; END IF;
  marks_correct := COALESCE((session_row.jumbled_exam_data->>'marksCorrect')::numeric, 4);
  marks_incorrect := COALESCE((session_row.jumbled_exam_data->>'marksIncorrect')::numeric, -1);

  FOR answer_entry IN SELECT key, value FROM jsonb_each(answers_obj) LOOP
    total_questions := total_questions + 1;
    answer_data := answer_entry.value;
    response_data := COALESCE(response_map->answer_entry.key, '{}'::jsonb);
    subject_name := COALESCE(NULLIF(answer_data->>'subject', ''), 'General');
    subject_scores := jsonb_set(subject_scores, ARRAY[subject_name],
      COALESCE(subject_scores->subject_name, '0'::jsonb), true);
    is_attempted := COALESCE(
      response_data->>'status' IN ('ANSWERED', 'ANSWERED_MARKED')
      AND NULLIF(btrim(response_data->>'selected_option'), '') IS NOT NULL,
      false
    );
    is_correct := false;

    IF is_attempted THEN
      IF upper(COALESCE(answer_data->>'type', 'MCQ')) IN ('NUMERICAL', 'NAT') THEN
        user_val := (response_data->>'selected_option')::numeric;
        correct_val := (answer_data->>'correct_answer')::numeric;
        is_correct := abs(user_val - correct_val) < 0.00001;
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

  INSERT INTO public.student_results (
    exam_id, student_id, student_name, total_score, max_score,
    correct, incorrect, unattempted, subject_scores, submitted_at
  ) VALUES (
    exam_id_param::text, student_row.student_id, student_row.name, total_score,
    total_questions * marks_correct, correct_count, incorrect_count,
    unattempted_count, subject_scores, clock_timestamp()
  ) ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions WHERE id = session_row.id;
  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;

  RETURN jsonb_build_object(
    'totalScore', result_row.total_score, 'maxScore', result_row.max_score,
    'correct', result_row.correct, 'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted, 'subjectScores', result_row.subject_scores
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_exam(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb) TO authenticated;

-- Termination can no longer be used by a candidate to choose a zero score.
-- It deterministically finalizes the last server-confirmed progress instead.
CREATE OR REPLACE FUNCTION public.terminate_exam(exam_id_param uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.submit_exam(exam_id_param, '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid) TO authenticated;

-- Rebuild the public view so candidates receive metadata only until the server
-- creates their timed session.  AAL2 admins still receive answer reconstruction.
CREATE OR REPLACE FUNCTION public.reconstruct_exam_questions(qdata jsonb, ans jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  subject_name text;
  question_obj jsonb;
  reconstructed_subject jsonb;
  reconstructed_questions jsonb := '{}'::jsonb;
  answer_info jsonb;
BEGIN
  IF qdata IS NULL OR jsonb_typeof(qdata->'questions') <> 'object' OR ans IS NULL THEN
    RETURN qdata;
  END IF;
  FOR subject_name IN SELECT jsonb_object_keys(qdata->'questions') LOOP
    reconstructed_subject := '[]'::jsonb;
    FOR question_obj IN SELECT value FROM jsonb_array_elements(qdata->'questions'->subject_name) LOOP
      answer_info := ans->(question_obj->>'id');
      IF answer_info IS NOT NULL THEN
        question_obj := jsonb_set(question_obj, '{correctAnswer}', answer_info->'correct_answer', true);
      END IF;
      reconstructed_subject := reconstructed_subject || jsonb_build_array(question_obj);
    END LOOP;
    reconstructed_questions := jsonb_set(reconstructed_questions, ARRAY[subject_name], reconstructed_subject, true);
  END LOOP;
  RETURN jsonb_set(qdata, '{questions}', reconstructed_questions, true);
END;
$$;

REVOKE ALL ON FUNCTION public.reconstruct_exam_questions(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconstruct_exam_questions(jsonb, jsonb) TO authenticated;

CREATE OR REPLACE VIEW public.cbt_exams WITH (security_invoker = true) AS
SELECT r.id, r.title, r.status, r.class, r.section, r.created_at,
  CASE
    WHEN public.is_admin_aal2() THEN public.reconstruct_exam_questions(r.questions_data, a.answers)
    ELSE r.questions_data - 'questions'
  END AS questions_data
FROM public.cbt_exams_raw r
LEFT JOIN public.cbt_exam_answers a ON r.id = a.exam_id;

-- Complete lifecycle matrix and full attempt-time immutability.
CREATE OR REPLACE FUNCTION public.handle_cbt_exams_modification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  clean_questions jsonb := '{}'::jsonb;
  answers_obj jsonb := '{}'::jsonb;
  subject_name text;
  question_obj jsonb;
  clean_subject_questions jsonb;
  clean_qdata jsonb;
  ans_val text;
  has_attempts boolean := false;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to modify exams';
  END IF;
  PERFORM set_config('cbt.trusted_exam_context', 'on', true);

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status NOT IN ('PENDING', 'ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'Invalid exam lifecycle status';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    has_attempts := EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text)
                 OR EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text);

    IF has_attempts AND OLD.status = 'ENDED' AND NEW.status <> 'ENDED' THEN
      RAISE EXCEPTION 'Cannot reactivate an ended exam that has student attempts or results';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (
        (OLD.status = 'PENDING' AND NEW.status = 'ACTIVE')
        OR (OLD.status = 'ACTIVE' AND NEW.status = 'ENDED')
        OR (OLD.status = 'ENDED' AND NEW.status = 'ACTIVE' AND NOT has_attempts)
      ) THEN
        RAISE EXCEPTION 'Invalid exam lifecycle transition from % to %', OLD.status, NEW.status;
      END IF;
    END IF;

    IF has_attempts AND (
      OLD.questions_data IS DISTINCT FROM NEW.questions_data
      OR OLD.class IS DISTINCT FROM NEW.class
      OR OLD.section IS DISTINCT FROM NEW.section
    ) THEN
      RAISE EXCEPTION 'Cannot modify exam questions, duration, scoring, or assignment after student attempts have begun';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_OP = 'UPDATE' AND NEW.questions_data IS NOT DISTINCT FROM OLD.questions_data THEN
      IF NEW.title IS NULL OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters';
      END IF;
      UPDATE public.cbt_exams_raw
      SET title = NEW.title, status = NEW.status, questions_data = OLD.questions_data,
          class = NEW.class, section = NEW.section
      WHERE id = NEW.id;
      RETURN NEW;
    END IF;

    PERFORM public.validate_full_exam_paper(NEW.title, NEW.questions_data);
    FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
      clean_subject_questions := '[]'::jsonb;
      FOR question_obj IN SELECT value FROM jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
        ans_val := btrim(COALESCE(question_obj->>'correctAnswer', question_obj->>'correct_answer', ''));
        IF upper(ans_val) IN ('A', 'B', 'C', 'D') THEN
          ans_val := (ascii(upper(ans_val)) - 65)::text;
        END IF;
        answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object(
          'correct_answer', ans_val,
          'subject', subject_name,
          'type', upper(COALESCE(question_obj->>'type', 'MCQ'))
        ), true);
        clean_subject_questions := clean_subject_questions || jsonb_build_array(
          question_obj - 'correctAnswer' - 'correct_answer'
        );
      END LOOP;
      clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
    END LOOP;
    clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);

    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, COALESCE(NEW.status, 'PENDING'), clean_qdata,
              NEW.class, NEW.section, COALESCE(NEW.created_at, clock_timestamp()));
    ELSE
      UPDATE public.cbt_exams_raw
      SET title = NEW.title, status = NEW.status, questions_data = clean_qdata,
          class = NEW.class, section = NEW.section
      WHERE id = NEW.id;
    END IF;

    INSERT INTO public.cbt_exam_answers (exam_id, answers)
    VALUES (NEW.id, answers_obj)
    ON CONFLICT (exam_id) DO UPDATE SET answers = EXCLUDED.answers;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'Cannot delete an active exam. End the exam first.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text) THEN
      RAISE EXCEPTION 'Cannot delete exam % because student submission results exist', OLD.id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text) THEN
      RAISE EXCEPTION 'Cannot delete exam % because active student attempts exist', OLD.id;
    END IF;
    DELETE FROM public.cbt_exams_raw WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_cbt_exams_modification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_cbt_exams_modification() TO authenticated;
