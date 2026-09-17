-- ============================================================================
-- Migration 20260910150000: Stage 3 — Exam Lifecycle, Offline Resilience,
-- and Concurrency-Safe Submission Recovery
-- ============================================================================

-- 1. Add monotonic versioning to active_sessions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'active_sessions'
      AND column_name = 'version'
  ) THEN
    ALTER TABLE public.active_sessions ADD COLUMN version integer DEFAULT 1 NOT NULL;
  END IF;
END $$;

-- 2. Ensure column-level UPDATE privileges for authenticated role cover version
REVOKE ALL ON public.active_sessions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.active_sessions TO authenticated;
GRANT UPDATE (user_responses, updated_at, version) ON public.active_sessions TO authenticated;

-- 3. Update active_sessions RLS policies
DROP POLICY IF EXISTS active_sessions_update_progress ON public.active_sessions;
CREATE POLICY active_sessions_update_progress ON public.active_sessions
  FOR UPDATE TO authenticated
  USING (
    (student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid()))
    OR public.is_admin_aal2()
  )
  WITH CHECK (
    (student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid()))
    OR public.is_admin_aal2()
  );

-- 4. Sanitization helper for responses against exam question paper
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
  valid_ids jsonb := '{}'::jsonb;
  cleaned_subject_responses jsonb;
  cleaned_responses jsonb := '{}'::jsonb;
  item jsonb;
  qid text;
  status_val text;
  valid_statuses text[] := ARRAY['NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED'];
BEGIN
  IF raw_responses IS NULL OR jsonb_typeof(raw_responses) <> 'object' THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Index valid question IDs from paper
  IF paper_questions IS NOT NULL AND jsonb_typeof(paper_questions) = 'object' THEN
    FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
      FOR item IN SELECT jsonb_array_elements(paper_questions->subject_name) LOOP
        qid := item->>'id';
        IF qid IS NOT NULL THEN
          valid_ids := jsonb_set(valid_ids, ARRAY[qid], 'true'::jsonb, true);
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  -- Clean and sanitize subject-level response arrays
  FOR subject_name IN SELECT jsonb_object_keys(raw_responses) LOOP
    IF jsonb_typeof(raw_responses->subject_name) = 'array' THEN
      cleaned_subject_responses := '[]'::jsonb;
      FOR item IN SELECT jsonb_array_elements(raw_responses->subject_name) LOOP
        IF jsonb_typeof(item) = 'object' THEN
          status_val := COALESCE(item->>'status', 'NOT_VISITED');
          IF NOT (status_val = ANY(valid_statuses)) THEN
            status_val := 'NOT_VISITED';
          END IF;
          cleaned_subject_responses := cleaned_subject_responses || jsonb_build_object(
            'selectedOption', item->'selectedOption',
            'status', status_val
          );
        ELSE
          cleaned_subject_responses := cleaned_subject_responses || jsonb_build_object(
            'selectedOption', NULL,
            'status', 'NOT_VISITED'
          );
        END IF;
      END LOOP;
      cleaned_responses := jsonb_set(cleaned_responses, ARRAY[subject_name], cleaned_subject_responses, true);
    END IF;
  END LOOP;

  RETURN cleaned_responses;
END;
$$;

-- 5. Server-Authoritative start_exam_session
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
  sanitized_responses jsonb;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  -- Advisory lock serializes concurrent session creations for this student/exam
  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND OR exam_row.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'This exam is not available';
  END IF;

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

  duration_seconds := GREATEST(COALESCE((exam_row.questions_data->>'duration')::integer, 180), 1) * 60;
  session_id := student_row.id::text || '_' || exam_id_param::text;

  SELECT * INTO session_row FROM public.active_sessions WHERE id = session_id;
  IF FOUND THEN
    -- Recalculate remaining seconds strictly from server-owned started_at
    remaining_seconds := duration_seconds - FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - session_row.started_at)))::integer;
    
    -- Past grace period: auto-terminate and finalize
    IF session_row.started_at IS NULL OR remaining_seconds < -180 THEN
      PERFORM public.terminate_exam(exam_id_param);
      RETURN jsonb_build_object('expired', true, 'time_left', 0);
    END IF;

    -- Merge valid progress if provided without replacing server paper
    IF responses_param IS NOT NULL AND jsonb_typeof(responses_param) = 'object' AND responses_param <> '{}'::jsonb THEN
      sanitized_responses := public.sanitize_exam_responses(
        responses_param,
        session_row.jumbled_exam_data->'questions'
      );
      UPDATE public.active_sessions
      SET user_responses = sanitized_responses,
          updated_at = clock_timestamp(),
          version = session_row.version + 1
      WHERE id = session_id
      RETURNING * INTO session_row;
    END IF;

    RETURN jsonb_build_object(
      'time_left', GREATEST(remaining_seconds, 0),
      'started_at', session_row.started_at,
      'jumbled_exam_data', session_row.jumbled_exam_data,
      'user_responses', session_row.user_responses,
      'version', session_row.version
    );
  END IF;

  -- Validate exam paper questions structure
  IF jsonb_typeof(exam_row.questions_data->'questions') <> 'object' THEN
    RAISE EXCEPTION 'Exam question data is invalid';
  END IF;

  -- Generate server-owned randomized question ordering
  FOR subject_name IN SELECT jsonb_object_keys(exam_row.questions_data->'questions') LOOP
    SELECT COALESCE(jsonb_agg(question ORDER BY random()), '[]'::jsonb)
    INTO shuffled_subject
    FROM jsonb_array_elements(exam_row.questions_data->'questions'->subject_name) AS question;
    shuffled_questions := jsonb_set(shuffled_questions, ARRAY[subject_name], shuffled_subject, true);
  END LOOP;
  server_exam_data := jsonb_set(exam_row.questions_data, '{questions}', shuffled_questions, true);

  sanitized_responses := public.sanitize_exam_responses(
    responses_param,
    server_exam_data->'questions'
  );

  INSERT INTO public.active_sessions
    (id, student_id, exam_id, user_responses, jumbled_exam_data, time_left, started_at, updated_at, version)
  VALUES
    (session_id, student_row.student_id, exam_id_param::text, sanitized_responses, server_exam_data, duration_seconds, clock_timestamp(), clock_timestamp(), 1)
  RETURNING * INTO session_row;

  RETURN jsonb_build_object(
    'time_left', duration_seconds,
    'started_at', session_row.started_at,
    'jumbled_exam_data', server_exam_data,
    'user_responses', sanitized_responses,
    'version', 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) TO authenticated;

-- 6. Concurrency-safe, optimistic autosave RPC
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
  sanitized_responses jsonb;
  new_version integer;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;
  
  -- Advisory lock for this session
  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  SELECT * INTO session_row FROM public.active_sessions WHERE id = session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted';
  END IF;

  -- Optimistic concurrency check: if client sent an outdated version, return conflict
  IF expected_version_param IS NOT NULL AND session_row.version > expected_version_param THEN
    RETURN jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'user_responses', session_row.user_responses
    );
  END IF;

  sanitized_responses := public.sanitize_exam_responses(
    responses_param,
    session_row.jumbled_exam_data->'questions'
  );

  new_version := session_row.version + 1;

  UPDATE public.active_sessions
  SET user_responses = sanitized_responses,
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

-- 7. Hardened, Idempotent submit_exam with Server-Owned Grading
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
  use_server_fallback boolean := false;
  effective_responses jsonb := responses_param;
  subj text;
  idx integer;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  -- Advisory lock serializes submissions for this candidate and exam
  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  -- Idempotent check: if already submitted, return committed result
  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'totalScore', result_row.total_score,
      'maxScore', result_row.max_score,
      'correct', result_row.correct,
      'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted,
      'subjectScores', result_row.subject_scores
    );
  END IF;

  -- Validate incoming responses payload shape and bounds
  IF responses_param IS NOT NULL AND jsonb_typeof(responses_param) <> 'array' THEN
    RAISE EXCEPTION 'Invalid response payload';
  END IF;

  IF responses_param IS NOT NULL AND jsonb_array_length(responses_param) > 1000 THEN
    RAISE EXCEPTION 'Response payload exceeds maximum allowed question count';
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

  -- 180-second fixed server grace window for network delivery
  max_seconds := GREATEST(COALESCE((exam_row.questions_data->>'duration')::integer, 180), 1) * 60 + 180;
  IF clock_timestamp() > session_row.started_at + make_interval(secs => max_seconds) THEN
    -- Past grace window: fallback to server-saved responses and mark submission as finalized past grace
    use_server_fallback := true;
  END IF;

  SELECT answers INTO answers_obj FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  IF answers_obj IS NULL THEN RAISE EXCEPTION 'Answer key not found'; END IF;

  -- If past grace window or client payload empty, convert session_row.user_responses to response array
  IF use_server_fallback OR effective_responses IS NULL OR jsonb_array_length(effective_responses) = 0 THEN
    effective_responses := '[]'::jsonb;
    IF session_row.user_responses IS NOT NULL AND session_row.jumbled_exam_data->'questions' IS NOT NULL THEN
      FOR subj IN SELECT jsonb_object_keys(session_row.jumbled_exam_data->'questions') LOOP
        idx := 0;
        FOR answer_entry IN SELECT * FROM jsonb_array_elements(session_row.jumbled_exam_data->'questions'->subj) LOOP
          response_data := session_row.user_responses->subj->idx;
          IF response_data IS NOT NULL THEN
            effective_responses := effective_responses || jsonb_build_object(
              'question_id', answer_entry.value->>'id',
              'selected_option', response_data->'selectedOption',
              'status', response_data->>'status'
            );
          END IF;
          idx := idx + 1;
        END LOOP;
      END LOOP;
    END IF;
  END IF;

  -- Build unique response mapping by question_id (discarding duplicates / malformed entries)
  SELECT COALESCE(jsonb_object_agg(item->>'question_id', item), '{}'::jsonb)
  INTO response_map
  FROM jsonb_array_elements(effective_responses) AS item
  WHERE jsonb_typeof(item) = 'object' AND item->>'question_id' IS NOT NULL;

  marks_correct := COALESCE((exam_row.questions_data->>'marksCorrect')::numeric, 4);
  marks_incorrect := COALESCE((exam_row.questions_data->>'marksIncorrect')::numeric, -1);

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

  -- Atomic result record creation and active session deletion
  INSERT INTO public.student_results (
    exam_id, student_id, student_name, total_score, max_score,
    correct, incorrect, unattempted, subject_scores, submitted_at
  ) VALUES (
    exam_id_param::text, student_row.student_id, student_row.name, total_score,
    total_questions * marks_correct, correct_count, incorrect_count, unattempted_count, subject_scores, clock_timestamp()
  ) ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions WHERE id = session_row.id;

  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text;

  RETURN jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_exam(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb) TO authenticated;

-- 8. Hardened terminate_exam with search path and session evaluation
CREATE OR REPLACE FUNCTION public.terminate_exam(exam_id_param uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row public.cbt_exams_raw%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  total_questions integer := 0;
  marks_correct numeric;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Student profile not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.student_results
    WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND OR exam_row.status NOT IN ('ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'This exam is not available';
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

  SELECT count(*) INTO total_questions
  FROM jsonb_each(COALESCE((SELECT answers FROM public.cbt_exam_answers WHERE exam_id = exam_id_param), '{}'::jsonb));
  marks_correct := COALESCE((exam_row.questions_data->>'marksCorrect')::numeric, 4);

  INSERT INTO public.student_results (
    exam_id, student_id, student_name, total_score, max_score,
    correct, incorrect, unattempted, subject_scores, submitted_at
  ) VALUES (
    exam_id_param::text, student_row.student_id, student_row.name, 0,
    total_questions * marks_correct, 0, 0, total_questions, '{}'::jsonb, clock_timestamp()
  ) ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions WHERE id = session_row.id;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid) TO authenticated;

-- 9. Update handle_cbt_exams_modification with lifecycle transition & in-flight immutability guards
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

  IF TG_OP = 'UPDATE' THEN
    -- Check if attempts or results exist
    has_attempts := EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text)
                 OR EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text);

    -- Guard status transitions
    IF OLD.status = 'ENDED' AND NEW.status = 'ACTIVE' AND has_attempts THEN
      RAISE EXCEPTION 'Cannot reactivate an ended exam that has student attempts or results';
    END IF;

    IF OLD.status = 'ACTIVE' AND NEW.status = 'PENDING' AND has_attempts THEN
      RAISE EXCEPTION 'Cannot revert an active exam with student attempts to pending';
    END IF;

    -- In-flight immutability: Cannot change questions, duration, marks, or assignment while attempts exist
    IF has_attempts THEN
      IF (OLD.questions_data->'questions') IS DISTINCT FROM (NEW.questions_data->'questions')
         OR (OLD.questions_data->>'duration') IS DISTINCT FROM (NEW.questions_data->>'duration')
         OR (OLD.questions_data->>'marksCorrect') IS DISTINCT FROM (NEW.questions_data->>'marksCorrect')
         OR (OLD.questions_data->>'marksIncorrect') IS DISTINCT FROM (NEW.questions_data->>'marksIncorrect')
         OR OLD.class IS DISTINCT FROM NEW.class
         OR OLD.section IS DISTINCT FROM NEW.section THEN
        RAISE EXCEPTION 'Cannot modify exam questions, duration, scoring, or assignment after student attempts have begun';
      END IF;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_OP = 'UPDATE' AND (NEW.questions_data IS NOT DISTINCT FROM OLD.questions_data) THEN
      -- Questions and answers are unchanged; admin is modifying metadata (title, status, class, section)
      IF NEW.title IS NULL OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 200 THEN
        RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters';
      END IF;

      UPDATE public.cbt_exams_raw
      SET title = NEW.title,
          status = NEW.status,
          questions_data = OLD.questions_data,
          class = NEW.class,
          section = NEW.section
      WHERE id = NEW.id;

      RETURN NEW;
    END IF;

    PERFORM public.validate_full_exam_paper(NEW.title, NEW.questions_data);

    FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
      clean_subject_questions := '[]'::jsonb;
      FOR question_obj IN SELECT jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
        ans_val := btrim(COALESCE(question_obj->>'correctAnswer', question_obj->>'correct_answer', ''));
        IF upper(ans_val) IN ('A', 'B', 'C', 'D') THEN
          ans_val := (ascii(upper(ans_val)) - 65)::text;
        END IF;

        answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object(
          'correct_answer', ans_val,
          'subject', subject_name,
          'type', upper(COALESCE(question_obj->>'type', 'MCQ'))
        ), true);

        clean_subject_questions := clean_subject_questions || (question_obj - 'correctAnswer' - 'correct_answer');
      END LOOP;
      clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
    END LOOP;

    clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);

    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, COALESCE(NEW.status, 'PENDING'), clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, clock_timestamp()));
    ELSE
      UPDATE public.cbt_exams_raw
      SET title = NEW.title,
          status = NEW.status,
          questions_data = clean_qdata,
          class = NEW.class,
          section = NEW.section
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
    DELETE FROM public.cbt_exams_raw WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
