-- Stage 21B, batch 2: authoritative exam start, autosave, submit, and terminate.

BEGIN;

CREATE OR REPLACE FUNCTION public.start_exam_session(
  pg_catalog.uuid,
  pg_catalog.jsonb,
  pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF $2 IS NOT NULL AND pg_catalog.octet_length($2::pg_catalog.text) OPERATOR(pg_catalog.>) 8388608 THEN
    RAISE EXCEPTION 'Exam payload exceeds 8 MiB';
  END IF;
  IF $3 IS NOT NULL AND pg_catalog.octet_length($3::pg_catalog.text) OPERATOR(pg_catalog.>) 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.start_exam_session_stage3_internal($1, $2, $3);
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_exam(
  pg_catalog.uuid,
  pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF $2 IS NOT NULL AND pg_catalog.octet_length($2::pg_catalog.text) OPERATOR(pg_catalog.>) 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.submit_exam_stage3_internal($1, $2);
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_exam_stage3_internal(
  exam_id_param pg_catalog.uuid,
  responses_param pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  result_row public.student_results%ROWTYPE;
  answers_obj pg_catalog.jsonb;
  response_map pg_catalog.jsonb;
  server_submission pg_catalog.jsonb;
  answer_entry pg_catalog.record;
  answer_data pg_catalog.jsonb;
  response_data pg_catalog.jsonb;
  marks_correct pg_catalog.numeric;
  marks_incorrect pg_catalog.numeric;
  total_score pg_catalog.numeric := 0;
  correct_count pg_catalog.int4 := 0;
  incorrect_count pg_catalog.int4 := 0;
  unattempted_count pg_catalog.int4 := 0;
  total_questions pg_catalog.int4 := 0;
  subject_scores pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  subject_name pg_catalog.text;
  is_attempted pg_catalog.bool;
  is_correct pg_catalog.bool;
  user_val pg_catalog.numeric;
  correct_val pg_catalog.numeric;
BEGIN
  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'totalScore', result_row.total_score,
      'maxScore', result_row.max_score,
      'correct', result_row.correct,
      'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted,
      'subjectScores', result_row.subject_scores
    );
  END IF;

  SELECT e.*
  INTO exam_row
  FROM public.cbt_exams_raw AS e
  WHERE e.id OPERATOR(pg_catalog.=) exam_id_param;
  IF NOT FOUND OR exam_row.status NOT IN ('ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'This exam is not available for submission';
  END IF;
  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class OPERATOR(pg_catalog.=) 'All'
    OR exam_row.class OPERATOR(pg_catalog.=) student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section OPERATOR(pg_catalog.=) 'All'
    OR exam_row.section OPERATOR(pg_catalog.=) student_row.section
  ) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) (
    student_row.id::pg_catalog.text
      OPERATOR(pg_catalog.||) '_'
      OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text
  );
  IF NOT FOUND OR session_row.started_at IS NULL OR session_row.deadline_at IS NULL THEN
    RAISE EXCEPTION 'Exam session was not started correctly';
  END IF;

  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  -- At/after the strict deadline, grade only the last server-confirmed snapshot.
  -- The 180-second grace period controls delivery, never answer acceptance.
  IF pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
    OR responses_param IS NULL
    OR (
      pg_catalog.jsonb_typeof(responses_param) OPERATOR(pg_catalog.=) 'array'
      AND pg_catalog.jsonb_array_length(responses_param) OPERATOR(pg_catalog.=) 0
    )
  THEN
    server_submission := public.exam_progress_to_submission(
      session_row.user_responses,
      session_row.jumbled_exam_data -> 'questions'
    );
    response_map := public.normalize_submission_response_map(
      server_submission,
      session_row.jumbled_exam_data -> 'questions'
    );
  ELSE
    response_map := public.normalize_submission_response_map(
      responses_param,
      session_row.jumbled_exam_data -> 'questions'
    );
  END IF;

  SELECT a.answers
  INTO answers_obj
  FROM public.cbt_exam_answers AS a
  WHERE a.exam_id OPERATOR(pg_catalog.=) exam_id_param;
  IF answers_obj IS NULL THEN
    RAISE EXCEPTION 'Answer key not found';
  END IF;

  marks_correct := COALESCE((session_row.jumbled_exam_data ->> 'marksCorrect')::pg_catalog.numeric, 4);
  marks_incorrect := COALESCE((session_row.jumbled_exam_data ->> 'marksIncorrect')::pg_catalog.numeric, -1);

  FOR answer_entry IN
    SELECT item.key, item.value
    FROM pg_catalog.jsonb_each(answers_obj) AS item
  LOOP
    total_questions := total_questions OPERATOR(pg_catalog.+) 1;
    answer_data := answer_entry.value;
    response_data := COALESCE(response_map -> answer_entry.key, '{}'::pg_catalog.jsonb);
    subject_name := COALESCE(NULLIF(answer_data ->> 'subject', ''), 'General');
    subject_scores := pg_catalog.jsonb_set(
      subject_scores,
      ARRAY[subject_name],
      COALESCE(subject_scores -> subject_name, '0'::pg_catalog.jsonb),
      true
    );
    is_attempted := COALESCE(
      (response_data ->> 'status') IN ('ANSWERED', 'ANSWERED_MARKED')
        AND NULLIF(pg_catalog.btrim(response_data ->> 'selected_option'), '') IS NOT NULL,
      false
    );
    is_correct := false;

    IF is_attempted THEN
      IF pg_catalog.upper(COALESCE(answer_data ->> 'type', 'MCQ')) IN ('NUMERICAL', 'NAT') THEN
        user_val := (response_data ->> 'selected_option')::pg_catalog.numeric;
        correct_val := (answer_data ->> 'correct_answer')::pg_catalog.numeric;
        is_correct := pg_catalog.abs(user_val OPERATOR(pg_catalog.-) correct_val)
          OPERATOR(pg_catalog.<) 0.00001;
      ELSE
        is_correct := (response_data ->> 'selected_option')
          OPERATOR(pg_catalog.=) (answer_data ->> 'correct_answer');
      END IF;
    END IF;

    IF NOT is_attempted THEN
      unattempted_count := unattempted_count OPERATOR(pg_catalog.+) 1;
    ELSIF is_correct THEN
      correct_count := correct_count OPERATOR(pg_catalog.+) 1;
      total_score := total_score OPERATOR(pg_catalog.+) marks_correct;
      subject_scores := pg_catalog.jsonb_set(
        subject_scores,
        ARRAY[subject_name],
        pg_catalog.to_jsonb(
          COALESCE((subject_scores ->> subject_name)::pg_catalog.numeric, 0)
            OPERATOR(pg_catalog.+) marks_correct
        ),
        true
      );
    ELSE
      incorrect_count := incorrect_count OPERATOR(pg_catalog.+) 1;
      total_score := total_score OPERATOR(pg_catalog.+) marks_incorrect;
      subject_scores := pg_catalog.jsonb_set(
        subject_scores,
        ARRAY[subject_name],
        pg_catalog.to_jsonb(
          COALESCE((subject_scores ->> subject_name)::pg_catalog.numeric, 0)
            OPERATOR(pg_catalog.+) marks_incorrect
        ),
        true
      );
    END IF;
  END LOOP;

  INSERT INTO public.student_results (
    exam_id,
    student_id,
    student_name,
    total_score,
    max_score,
    correct,
    incorrect,
    unattempted,
    subject_scores,
    submitted_at
  ) VALUES (
    exam_id_param::pg_catalog.text,
    student_row.student_id,
    student_row.name,
    total_score,
    total_questions OPERATOR(pg_catalog.*) marks_correct,
    correct_count,
    incorrect_count,
    unattempted_count,
    subject_scores,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_row.id;

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text;

  RETURN pg_catalog.jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.terminate_exam(pg_catalog.uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_current_student_session();
  PERFORM public.terminate_exam_stage3_internal($1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.terminate_exam_stage3_internal(
  exam_id_param pg_catalog.uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.submit_exam(exam_id_param, '[]'::pg_catalog.jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_exam_session_stage3_internal(
  exam_id_param pg_catalog.uuid,
  exam_data_param pg_catalog.jsonb,
  responses_param pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row public.cbt_exams_raw%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  duration_seconds pg_catalog.int4;
  remaining_seconds pg_catalog.int4;
  session_id pg_catalog.text;
  subject_name pg_catalog.text;
  shuffled_questions pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  shuffled_subject pg_catalog.jsonb;
  server_exam_data pg_catalog.jsonb;
  initial_responses pg_catalog.jsonb;
  start_time pg_catalog.timestamptz;
  final_result pg_catalog.jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  SELECT e.*
  INTO exam_row
  FROM public.cbt_exams_raw AS e
  WHERE e.id OPERATOR(pg_catalog.=) exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This exam is not available';
  END IF;

  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class OPERATOR(pg_catalog.=) 'All'
    OR exam_row.class OPERATOR(pg_catalog.=) student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section OPERATOR(pg_catalog.=) 'All'
    OR exam_row.section OPERATOR(pg_catalog.=) student_row.section
  ) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.student_results AS r
    WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
      AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text
  ) THEN
    RAISE EXCEPTION 'This exam has already been submitted';
  END IF;

  session_id := student_row.id::pg_catalog.text
    OPERATOR(pg_catalog.||) '_'
    OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_id;

  IF FOUND THEN
    IF exam_row.status NOT IN ('ACTIVE', 'ENDED') OR session_row.started_at IS NULL THEN
      RAISE EXCEPTION 'This exam session is not available';
    END IF;

    IF session_row.deadline_at IS NULL THEN
      duration_seconds := GREATEST(
        COALESCE(((session_row.jumbled_exam_data ->> 'duration')::pg_catalog.int4), 180),
        1
      ) OPERATOR(pg_catalog.*) 60;
      UPDATE public.active_sessions AS s
      SET deadline_at = session_row.started_at + pg_catalog.make_interval(secs => duration_seconds)
      WHERE s.id OPERATOR(pg_catalog.=) session_id
      RETURNING s.* INTO session_row;
    END IF;

    IF pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at THEN
      final_result := public.submit_exam(exam_id_param, '[]'::pg_catalog.jsonb);
      RETURN pg_catalog.jsonb_build_object(
        'expired', true,
        'time_left', 0,
        'result', final_result
      );
    END IF;

    remaining_seconds := GREATEST(
      pg_catalog.ceil(
        EXTRACT(EPOCH FROM (session_row.deadline_at - pg_catalog.clock_timestamp()))
      )::pg_catalog.int4,
      0
    );
    RETURN pg_catalog.jsonb_build_object(
      'time_left', remaining_seconds,
      'started_at', session_row.started_at,
      'deadline_at', session_row.deadline_at,
      'jumbled_exam_data', session_row.jumbled_exam_data,
      'user_responses', session_row.user_responses,
      'version', session_row.version
    );
  END IF;

  IF exam_row.status OPERATOR(pg_catalog.<>) 'ACTIVE' THEN
    RAISE EXCEPTION 'This exam is not available';
  END IF;
  IF pg_catalog.jsonb_typeof(exam_row.questions_data -> 'questions') OPERATOR(pg_catalog.<>) 'object' THEN
    RAISE EXCEPTION 'Exam question data is invalid';
  END IF;

  FOR subject_name IN
    SELECT pg_catalog.jsonb_object_keys(exam_row.questions_data -> 'questions')
  LOOP
    SELECT COALESCE(pg_catalog.jsonb_agg(question ORDER BY pg_catalog.random()), '[]'::pg_catalog.jsonb)
    INTO shuffled_subject
    FROM pg_catalog.jsonb_array_elements(
      exam_row.questions_data -> 'questions' -> subject_name
    ) AS question;
    shuffled_questions := pg_catalog.jsonb_set(
      shuffled_questions,
      ARRAY[subject_name],
      shuffled_subject,
      true
    );
  END LOOP;

  server_exam_data := pg_catalog.jsonb_set(
    exam_row.questions_data,
    '{questions}',
    shuffled_questions,
    true
  );
  initial_responses := public.sanitize_exam_responses(
    '{}'::pg_catalog.jsonb,
    server_exam_data -> 'questions'
  );
  duration_seconds := GREATEST(
    COALESCE(((server_exam_data ->> 'duration')::pg_catalog.int4), 180),
    1
  ) OPERATOR(pg_catalog.*) 60;
  start_time := pg_catalog.clock_timestamp();

  INSERT INTO public.active_sessions (
    id,
    student_id,
    exam_id,
    user_responses,
    jumbled_exam_data,
    time_left,
    started_at,
    deadline_at,
    updated_at,
    version
  ) VALUES (
    session_id,
    student_row.student_id,
    exam_id_param::pg_catalog.text,
    initial_responses,
    server_exam_data,
    duration_seconds,
    start_time,
    start_time + pg_catalog.make_interval(secs => duration_seconds),
    start_time,
    1
  )
  RETURNING * INTO session_row;

  RETURN pg_catalog.jsonb_build_object(
    'time_left', duration_seconds,
    'started_at', session_row.started_at,
    'deadline_at', session_row.deadline_at,
    'jumbled_exam_data', session_row.jumbled_exam_data,
    'user_responses', session_row.user_responses,
    'version', session_row.version
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_active_session_progress(
  pg_catalog.uuid,
  pg_catalog.jsonb,
  pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF $2 IS NOT NULL AND pg_catalog.octet_length($2::pg_catalog.text) OPERATOR(pg_catalog.>) 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.sync_active_session_progress_stage3_internal($1, $2, $3);
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_active_session_progress_stage3_internal(
  exam_id_param pg_catalog.uuid,
  responses_param pg_catalog.jsonb,
  expected_version_param pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_id pg_catalog.text;
  canonical_responses pg_catalog.jsonb;
  new_version pg_catalog.int4;
BEGIN
  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;
  IF expected_version_param IS NULL OR expected_version_param OPERATOR(pg_catalog.<) 1 THEN
    RAISE EXCEPTION 'A positive expected session version is required';
  END IF;

  session_id := student_row.id::pg_catalog.text
    OPERATOR(pg_catalog.||) '_'
    OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted';
  END IF;

  IF expected_version_param OPERATOR(pg_catalog.<>) session_row.version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'user_responses', session_row.user_responses
    );
  END IF;
  IF session_row.deadline_at IS NULL
    OR pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
  THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved';
  END IF;

  canonical_responses := public.sanitize_exam_responses(
    responses_param,
    session_row.jumbled_exam_data -> 'questions'
  );
  new_version := session_row.version OPERATOR(pg_catalog.+) 1;
  UPDATE public.active_sessions AS s
  SET user_responses = canonical_responses,
      updated_at = pg_catalog.clock_timestamp(),
      version = new_version
  WHERE s.id OPERATOR(pg_catalog.=) session_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'conflict', false,
    'version', new_version,
    'saved_at', pg_catalog.clock_timestamp()
  );
END;
$function$;

COMMIT;
