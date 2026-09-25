-- Migration hygiene + stable error codes for the exam hot path.
--
-- 1. The five live functions that still carried development "stage" names are
--    renamed to domain names. All callers are redefined below in the same
--    transaction, so nothing references an old name afterwards:
--      submit_exam_stage3_internal  ->  submit_exam_internal
--      start_exam_session_stage3_internal  ->  start_exam_session_internal
--      sync_active_session_progress_stage3_internal  ->  sync_active_session_progress_internal
--      terminate_exam_stage3_internal  ->  terminate_exam_internal
--      validate_full_exam_paper_stage1_internal  ->  validate_full_exam_paper_internal
-- 2. Client-relevant errors raised by the exam internals now carry stable
--    SQLSTATEs (messages unchanged). See docs/ERROR_CODES.md and src/appErrors.js:
--      EX005 already submitted   EX006 not assigned        EX007 not available
--      EX008 time expired        EX009 not started         EX010 answer key missing
--      EX011 session not found   EX012 invalid payload     (EX002/EX004 as before)
-- Bodies are otherwise identical to the previous definitions.

BEGIN;

ALTER FUNCTION public.submit_exam_stage3_internal(uuid, jsonb) RENAME TO submit_exam_internal;
ALTER FUNCTION public.start_exam_session_stage3_internal(uuid, jsonb, jsonb) RENAME TO start_exam_session_internal;
ALTER FUNCTION public.sync_active_session_progress_stage3_internal(uuid, jsonb, integer) RENAME TO sync_active_session_progress_internal;
ALTER FUNCTION public.terminate_exam_stage3_internal(uuid) RENAME TO terminate_exam_internal;
ALTER FUNCTION public.validate_full_exam_paper_stage1_internal(text, jsonb) RENAME TO validate_full_exam_paper_internal;

CREATE OR REPLACE FUNCTION public.submit_exam_internal(exam_id_param uuid, responses_param jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
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
    RAISE EXCEPTION 'This exam is not available for submission' USING ERRCODE = 'EX007';
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
    RAISE EXCEPTION 'This exam is not assigned to you' USING ERRCODE = 'EX006';
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
    RAISE EXCEPTION 'Exam session was not started correctly' USING ERRCODE = 'EX009';
  END IF;

  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB' USING ERRCODE = 'EX012';
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
    RAISE EXCEPTION 'Answer key not found' USING ERRCODE = 'EX010';
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

CREATE OR REPLACE FUNCTION public.start_exam_session_internal(exam_id_param uuid, exam_data_param jsonb, responses_param jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
  -- These legacy parameters remain for PostgREST compatibility. The server-owned paper and initial response state intentionally replace their values.
  PERFORM exam_data_param, responses_param;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = 'EX004';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
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
    RAISE EXCEPTION 'This exam is not available' USING ERRCODE = 'EX007';
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
    RAISE EXCEPTION 'This exam is not assigned to you' USING ERRCODE = 'EX006';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.student_results AS r
    WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
      AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text
  ) THEN
    RAISE EXCEPTION 'This exam has already been submitted' USING ERRCODE = 'EX005';
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
      RAISE EXCEPTION 'This exam session is not available' USING ERRCODE = 'EX007';
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
    RAISE EXCEPTION 'This exam is not available' USING ERRCODE = 'EX007';
  END IF;
  IF pg_catalog.jsonb_typeof(exam_row.questions_data -> 'questions') OPERATOR(pg_catalog.<>) 'object' THEN
    RAISE EXCEPTION 'Exam question data is invalid' USING ERRCODE = 'EX012';
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

CREATE OR REPLACE FUNCTION public.sync_active_session_progress_internal(exam_id_param uuid, responses_param jsonb, expected_version_param integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;
  IF expected_version_param IS NULL OR expected_version_param OPERATOR(pg_catalog.<) 1 THEN
    RAISE EXCEPTION 'A positive expected session version is required' USING ERRCODE = 'EX012';
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

  -- Read only the small columns. The full shuffled paper (jumbled_exam_data)
  -- stays in TOAST storage; its compact response_schema is enough to validate.
  SELECT s.id, s.version, s.deadline_at, s.response_schema
  INTO session_row.id, session_row.version, session_row.deadline_at, session_row.response_schema
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted' USING ERRCODE = 'EX011';
  END IF;

  IF expected_version_param OPERATOR(pg_catalog.<>) session_row.version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'user_responses', (
        SELECT s.user_responses FROM public.active_sessions AS s
        WHERE s.id OPERATOR(pg_catalog.=) session_id
      )
    );
  END IF;
  IF session_row.deadline_at IS NULL
    OR pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
  THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved' USING ERRCODE = 'EX008';
  END IF;

  canonical_responses := public.sanitize_exam_responses(
    responses_param,
    COALESCE(
      session_row.response_schema -> 'questions',
      (SELECT s.jumbled_exam_data -> 'questions' FROM public.active_sessions AS s
       WHERE s.id OPERATOR(pg_catalog.=) session_id)
    )
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

CREATE OR REPLACE FUNCTION public.terminate_exam_internal(exam_id_param uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.submit_exam(exam_id_param, '[]'::pg_catalog.jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_exam(exam_id_param uuid, responses_param jsonb, expected_version_param integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  result_row public.student_results%ROWTYPE;
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  BEGIN
    PERFORM public.assert_current_student_session();
  EXCEPTION WHEN OTHERS THEN
    -- A response may be lost after a successful commit. Even if a newer device
    -- has since taken over, return the already committed immutable result.
    -- This branch cannot create, alter, or delete a result or active session.
    SELECT r.*
    INTO result_row
    FROM public.students AS s
    JOIN public.student_results AS r
      ON r.student_id OPERATOR(pg_catalog.=) s.student_id
     AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text
    WHERE s.id OPERATOR(pg_catalog.=) auth.uid();

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
    RAISE;
  END;

  -- The browser confirmed its final answers with a versioned autosave just
  -- before submitting. Grade the stored server snapshot so a stale tab cannot
  -- overwrite newer answers and the admin review matches the grade exactly.
  IF expected_version_param IS NOT NULL THEN
    RETURN public.submit_exam_internal(exam_id_param, NULL);
  END IF;

  -- Legacy clients (no version) keep the previous contract.
  RETURN public.submit_exam_internal(exam_id_param, responses_param);
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_expired_sessions_internal(batch_limit_param integer, grace_seconds_param integer, actor_id_param uuid, source_param text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  previous_sub pg_catalog.text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  candidate record;
  student_user_id pg_catalog.uuid;
  finalized_count pg_catalog.int4 := 0;
  skipped_count pg_catalog.int4 := 0;
  failed_count pg_catalog.int4 := 0;
BEGIN
  IF batch_limit_param IS NULL OR batch_limit_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Batch limit must be between 1 and 500';
  END IF;

  FOR candidate IN
    SELECT s.id, s.student_id, s.exam_id, s.deadline_at
    FROM public.active_sessions AS s
    WHERE s.deadline_at IS NOT NULL
      AND s.deadline_at OPERATOR(pg_catalog.<=) (
        pg_catalog.clock_timestamp() OPERATOR(pg_catalog.-)
          pg_catalog.make_interval(secs => GREATEST(grace_seconds_param, 0))
      )
    ORDER BY s.deadline_at, s.id
    LIMIT batch_limit_param
  LOOP
    BEGIN
      IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended(
          candidate.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) candidate.exam_id,
          0
        )
      ) THEN
        skipped_count := skipped_count OPERATOR(pg_catalog.+) 1;
        CONTINUE;
      END IF;

      PERFORM 1 FROM public.active_sessions AS s
      WHERE s.id OPERATOR(pg_catalog.=) candidate.id
      FOR UPDATE NOWAIT;
      IF NOT FOUND THEN
        -- The candidate submitted between the scan and the lock.
        CONTINUE;
      END IF;

      SELECT st.id INTO student_user_id
      FROM public.students AS st
      WHERE st.student_id OPERATOR(pg_catalog.=) candidate.student_id
        AND st.archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Expired session % has no active student record', candidate.id;
      END IF;

      -- Reuse the private, server-authoritative grader. Only the local
      -- transaction claim changes, and it is restored below.
      PERFORM pg_catalog.set_config('request.jwt.claim.sub', student_user_id::pg_catalog.text, true);
      PERFORM public.submit_exam_internal(candidate.exam_id::pg_catalog.uuid, '[]'::pg_catalog.jsonb);
      DELETE FROM public.active_sessions AS s WHERE s.id OPERATOR(pg_catalog.=) candidate.id;
      PERFORM pg_catalog.set_config('request.jwt.claim.sub', COALESCE(previous_sub, ''), true);

      INSERT INTO public.admin_audit_events (
        actor_user_id, action, target_type, target_id, metadata
      ) VALUES (
        actor_id_param, 'FINALIZE_EXPIRED_SESSION', 'active_session', candidate.id,
        pg_catalog.jsonb_build_object(
          'student_id', candidate.student_id,
          'exam_id', candidate.exam_id,
          'deadline_at', candidate.deadline_at,
          'source', source_param
        )
      );
      finalized_count := finalized_count OPERATOR(pg_catalog.+) 1;
    EXCEPTION
      WHEN lock_not_available THEN
        skipped_count := skipped_count OPERATOR(pg_catalog.+) 1;
      WHEN OTHERS THEN
        -- One broken attempt must not block every other candidate's result.
        failed_count := failed_count OPERATOR(pg_catalog.+) 1;
        RAISE WARNING 'finalize_expired_session_failed session=% sqlstate=% message=%',
          candidate.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', COALESCE(previous_sub, ''), true);
  RETURN pg_catalog.jsonb_build_object(
    'finalized', finalized_count,
    'skipped', skipped_count,
    'failed', failed_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.terminate_exam(exam_id_param uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.assert_current_student_session();
  PERFORM public.terminate_exam_internal(exam_id_param);
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_full_exam_paper(p_title text, p_questions_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.assert_exam_payload_bounds(p_questions_data);
  PERFORM public.validate_full_exam_paper_internal(p_title, p_questions_data);
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_exam_session(exam_id_param uuid, exam_data_param jsonb, responses_param jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF exam_data_param IS NOT NULL
    AND pg_catalog.octet_length(exam_data_param::pg_catalog.text) OPERATOR(pg_catalog.>) 8388608
  THEN
    RAISE EXCEPTION 'Exam payload exceeds 8 MiB';
  END IF;
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.start_exam_session_internal(
    exam_id_param,
    exam_data_param,
    responses_param
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_active_session_progress(exam_id_param uuid, responses_param jsonb, expected_version_param integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.sync_active_session_progress_internal(
    exam_id_param,
    responses_param,
    expected_version_param
  );
END;
$function$;

COMMIT;
