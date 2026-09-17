-- ============================================================================
-- Stage 1: Deep Exam Data Validation & Raw-Table Bypass Prevention
-- Forward-only migration closing raw table bypasses and enforcing deep exam
-- paper integrity (MCQ text/image options, numerical answers, and atomic answer separation).
-- ============================================================================

-- 1. Deep Exam Validation Function
-- Validates the complete incoming paper (including private answer keys)
CREATE OR REPLACE FUNCTION public.validate_full_exam_paper(
  p_title text,
  p_questions_data jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration integer;
  v_marks_correct numeric;
  v_marks_incorrect numeric;
  v_subjects_array jsonb;
  v_questions_obj jsonb;
  v_sub_text text;
  v_seen_subjects text[] := ARRAY[]::text[];
  v_seen_qids text[] := ARRAY[]::text[];
  v_total_questions integer := 0;
  v_subject_list jsonb;
  v_q jsonb;
  v_qid text;
  v_qtext text;
  v_qtype text;
  v_options jsonb;
  v_seen_opts text[];
  v_opt_val text;
  v_ans_raw text;
  v_opt_idx integer;
  v_opt_text text;
  v_opt_img text;
  v_opt_key text;
BEGIN
  -- 1. Validate Title
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters';
  END IF;

  -- 2. Validate Questions Data root
  IF p_questions_data IS NULL OR jsonb_typeof(p_questions_data) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions_data must be a valid JSON object';
  END IF;

  -- 3. Validate Duration (1 to 600 minutes)
  IF (p_questions_data->>'duration') IS NULL OR (p_questions_data->>'duration') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be an integer';
  END IF;
  v_duration := (p_questions_data->>'duration')::integer;
  IF v_duration NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be between 1 and 600 minutes';
  END IF;

  -- 4. Validate Marking Scheme
  IF (p_questions_data->>'marksCorrect') IS NULL OR (p_questions_data->>'marksCorrect') !~ '^[+]?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Exam validation failed: marksCorrect must be a positive number';
  END IF;
  v_marks_correct := (p_questions_data->>'marksCorrect')::numeric;
  IF v_marks_correct NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Exam validation failed: marksCorrect must be between 0 and 100';
  END IF;

  IF (p_questions_data->>'marksIncorrect') IS NULL OR (p_questions_data->>'marksIncorrect') !~ '^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Exam validation failed: marksIncorrect must be a number';
  END IF;
  v_marks_incorrect := (p_questions_data->>'marksIncorrect')::numeric;
  IF v_marks_incorrect NOT BETWEEN -100 AND 0 THEN
    RAISE EXCEPTION 'Exam validation failed: marksIncorrect must be between -100 and 0';
  END IF;

  -- 5. Validate Subjects array
  v_subjects_array := p_questions_data->'subjects';
  IF v_subjects_array IS NULL OR jsonb_typeof(v_subjects_array) <> 'array' OR jsonb_array_length(v_subjects_array) = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: subjects must be a non-empty array';
  END IF;

  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF v_sub_text IS NULL OR length(btrim(v_sub_text)) = 0 THEN
      RAISE EXCEPTION 'Exam validation failed: subject names cannot be empty';
    END IF;
    IF lower(btrim(v_sub_text)) = ANY(v_seen_subjects) THEN
      RAISE EXCEPTION 'Exam validation failed: duplicate subject name "%"', v_sub_text;
    END IF;
    v_seen_subjects := array_append(v_seen_subjects, lower(btrim(v_sub_text)));
  END LOOP;

  -- 6. Validate Questions object
  v_questions_obj := p_questions_data->'questions';
  IF v_questions_obj IS NULL OR jsonb_typeof(v_questions_obj) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions must be an object mapping subjects to question lists';
  END IF;

  -- Ensure every declared subject exists in questions object
  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF NOT (v_questions_obj ? v_sub_text) THEN
      RAISE EXCEPTION 'Exam validation failed: declared subject "%" is missing from questions object', v_sub_text;
    END IF;
    IF jsonb_typeof(v_questions_obj->v_sub_text) <> 'array' THEN
      RAISE EXCEPTION 'Exam validation failed: questions for subject "%" must be a JSON array', v_sub_text;
    END IF;
  END LOOP;

  -- Ensure no extra undeclared subjects in questions object
  FOR v_sub_text IN SELECT jsonb_object_keys(v_questions_obj) LOOP
    IF NOT (lower(btrim(v_sub_text)) = ANY(v_seen_subjects)) THEN
      RAISE EXCEPTION 'Exam validation failed: questions contains undeclared subject "%"', v_sub_text;
    END IF;
  END LOOP;

  -- 7. Validate each question across all subjects
  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    v_subject_list := v_questions_obj->v_sub_text;
    FOR v_q IN SELECT jsonb_array_elements(v_subject_list) LOOP
      v_total_questions := v_total_questions + 1;

      IF jsonb_typeof(v_q) <> 'object' THEN
        RAISE EXCEPTION 'Exam validation failed: question item in subject "%" must be an object', v_sub_text;
      END IF;

      -- Question ID: non-empty, globally unique across entire paper
      v_qid := btrim(COALESCE(v_q->>'id', ''));
      IF length(v_qid) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Exam validation failed: question in subject "%" is missing a valid id (must be 1-120 chars)', v_sub_text;
      END IF;
      IF v_qid = ANY(v_seen_qids) THEN
        RAISE EXCEPTION 'Exam validation failed: duplicate question id "%" detected', v_qid;
      END IF;
      v_seen_qids := array_append(v_seen_qids, v_qid);

      -- Prompt: text or question image required
      v_qtext := btrim(COALESCE(v_q->>'text', v_q->>'question_text', ''));
      IF length(v_qtext) = 0
         AND length(btrim(COALESCE(v_q->>'questionImageUrl', v_q->>'imageUrl', ''))) = 0 THEN
        RAISE EXCEPTION 'Exam validation failed: question "%" must have question text or a question image', v_qid;
      END IF;

      -- Question Type
      v_qtype := upper(COALESCE(v_q->>'type', 'MCQ'));
      IF v_qtype NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
        RAISE EXCEPTION 'Exam validation failed: question "%" has unsupported type "%"', v_qid, v_qtype;
      END IF;

      -- Options & Correct Answer
      v_ans_raw := btrim(COALESCE(v_q->>'correctAnswer', v_q->>'correct_answer', ''));

      IF v_qtype = 'MCQ' THEN
        v_options := v_q->'options';
        IF v_options IS NULL OR jsonb_typeof(v_options) <> 'array' OR jsonb_array_length(v_options) <> 4 THEN
          RAISE EXCEPTION 'Exam validation failed: MCQ question "%" must have exactly 4 options', v_qid;
        END IF;

        v_seen_opts := ARRAY[]::text[];
        v_opt_idx := 0;
        FOR v_opt_val IN SELECT jsonb_array_elements_text(v_options) LOOP
          v_opt_text := btrim(COALESCE(v_opt_val, ''));

          -- Extract option image from optionImageUrls or option_image_urls
          v_opt_img := '';
          IF v_q ? 'optionImageUrls' AND jsonb_typeof(v_q->'optionImageUrls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'optionImageUrls'->>v_opt_idx, ''));
          ELSIF v_q ? 'option_image_urls' AND jsonb_typeof(v_q->'option_image_urls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'option_image_urls'->>v_opt_idx, ''));
          END IF;
          IF lower(v_opt_img) = 'null' THEN
            v_opt_img := '';
          END IF;

          -- Reject only when both text and image are absent
          IF length(v_opt_text) = 0 AND length(v_opt_img) = 0 THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" option % is missing both text and image', v_qid, v_opt_idx + 1;
          END IF;

          -- Construct normalized option key for uniqueness check
          IF length(v_opt_text) > 0 AND length(v_opt_img) > 0 THEN
            v_opt_key := 'mixed:' || lower(v_opt_text) || '|img:' || v_opt_img;
          ELSIF length(v_opt_img) > 0 THEN
            v_opt_key := 'img:' || v_opt_img;
          ELSE
            v_opt_key := 'text:' || lower(v_opt_text);
          END IF;

          IF v_opt_key = ANY(v_seen_opts) THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" contains duplicate options (option %)', v_qid, v_opt_idx + 1;
          END IF;
          v_seen_opts := array_append(v_seen_opts, v_opt_key);
          v_opt_idx := v_opt_idx + 1;
        END LOOP;

        -- Normalize A, B, C, D to 0, 1, 2, 3
        IF upper(v_ans_raw) IN ('A', 'B', 'C', 'D') THEN
          v_ans_raw := (ascii(upper(v_ans_raw)) - 65)::text;
        END IF;
        IF v_ans_raw NOT IN ('0', '1', '2', '3') THEN
          RAISE EXCEPTION 'Exam validation failed: MCQ question "%" has invalid correct answer "%" (must be 0, 1, 2, or 3)', v_qid, v_ans_raw;
        END IF;

      ELSIF v_qtype IN ('NUMERICAL', 'NAT') THEN
        IF v_q ? 'options' AND jsonb_typeof(v_q->'options') = 'array' AND jsonb_array_length(v_q->'options') > 0 THEN
          RAISE EXCEPTION 'Exam validation failed: Numerical question "%" must not have multiple-choice options', v_qid;
        END IF;

        IF v_ans_raw !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
          RAISE EXCEPTION 'Exam validation failed: Numerical question "%" has invalid non-numeric answer "%"', v_qid, v_ans_raw;
        END IF;
      END IF;

    END LOOP;
  END LOOP;

  -- 8. Ensure at least one question
  IF v_total_questions = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: exam must contain at least one question';
  END IF;
END;
$$;

-- 2. Function to validate stripped questions data in cbt_exams_raw (public questions)
CREATE OR REPLACE FUNCTION public.validate_cbt_exams_raw_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration integer;
  v_marks_correct numeric;
  v_marks_incorrect numeric;
  v_subjects_array jsonb;
  v_questions_obj jsonb;
  v_sub_text text;
  v_seen_subjects text[] := ARRAY[]::text[];
  v_seen_qids text[] := ARRAY[]::text[];
  v_total_questions integer := 0;
  v_subject_list jsonb;
  v_q jsonb;
  v_qid text;
  v_qtype text;
  v_options jsonb;
  v_opt_val text;
  v_opt_idx integer;
  v_opt_text text;
  v_opt_img text;
  v_opt_key text;
  v_seen_opts text[];
BEGIN
  IF NEW.title IS NULL OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters';
  END IF;

  IF NEW.questions_data IS NULL OR jsonb_typeof(NEW.questions_data) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions_data must be a valid JSON object';
  END IF;

  -- Duration
  IF (NEW.questions_data->>'duration') IS NULL OR (NEW.questions_data->>'duration') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be an integer';
  END IF;
  v_duration := (NEW.questions_data->>'duration')::integer;
  IF v_duration NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be between 1 and 600 minutes';
  END IF;

  -- Marks
  v_marks_correct := (NEW.questions_data->>'marksCorrect')::numeric;
  IF v_marks_correct IS NULL OR v_marks_correct NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Exam validation failed: marksCorrect must be between 0 and 100';
  END IF;

  v_marks_incorrect := (NEW.questions_data->>'marksIncorrect')::numeric;
  IF v_marks_incorrect IS NULL OR v_marks_incorrect NOT BETWEEN -100 AND 0 THEN
    RAISE EXCEPTION 'Exam validation failed: marksIncorrect must be between -100 and 0';
  END IF;

  -- Subjects
  v_subjects_array := NEW.questions_data->'subjects';
  IF v_subjects_array IS NULL OR jsonb_typeof(v_subjects_array) <> 'array' OR jsonb_array_length(v_subjects_array) = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: subjects must be a non-empty array';
  END IF;

  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF v_sub_text IS NULL OR length(btrim(v_sub_text)) = 0 THEN
      RAISE EXCEPTION 'Exam validation failed: subject names cannot be empty';
    END IF;
    IF lower(btrim(v_sub_text)) = ANY(v_seen_subjects) THEN
      RAISE EXCEPTION 'Exam validation failed: duplicate subject "%"', v_sub_text;
    END IF;
    v_seen_subjects := array_append(v_seen_subjects, lower(btrim(v_sub_text)));
  END LOOP;

  -- Questions object
  v_questions_obj := NEW.questions_data->'questions';
  IF v_questions_obj IS NULL OR jsonb_typeof(v_questions_obj) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions must be an object';
  END IF;

  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF NOT (v_questions_obj ? v_sub_text) OR jsonb_typeof(v_questions_obj->v_sub_text) <> 'array' THEN
      RAISE EXCEPTION 'Exam validation failed: missing questions array for subject "%"', v_sub_text;
    END IF;
  END LOOP;

  FOR v_sub_text IN SELECT jsonb_object_keys(v_questions_obj) LOOP
    IF NOT (lower(btrim(v_sub_text)) = ANY(v_seen_subjects)) THEN
      RAISE EXCEPTION 'Exam validation failed: undeclared subject "%" in questions', v_sub_text;
    END IF;
  END LOOP;

  -- Questions list
  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    v_subject_list := v_questions_obj->v_sub_text;
    FOR v_q IN SELECT jsonb_array_elements(v_subject_list) LOOP
      v_total_questions := v_total_questions + 1;
      v_qid := btrim(COALESCE(v_q->>'id', ''));
      IF length(v_qid) = 0 THEN
        RAISE EXCEPTION 'Exam validation failed: missing question id';
      END IF;
      IF v_qid = ANY(v_seen_qids) THEN
        RAISE EXCEPTION 'Exam validation failed: duplicate question id "%"', v_qid;
      END IF;
      v_seen_qids := array_append(v_seen_qids, v_qid);

      v_qtype := upper(COALESCE(v_q->>'type', 'MCQ'));
      IF v_qtype NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
        RAISE EXCEPTION 'Exam validation failed: invalid question type "%"', v_qtype;
      END IF;

      IF v_qtype = 'MCQ' THEN
        v_options := v_q->'options';
        IF v_options IS NULL OR jsonb_typeof(v_options) <> 'array' OR jsonb_array_length(v_options) <> 4 THEN
          RAISE EXCEPTION 'Exam validation failed: MCQ "%" must have exactly 4 options', v_qid;
        END IF;

        v_seen_opts := ARRAY[]::text[];
        v_opt_idx := 0;
        FOR v_opt_val IN SELECT jsonb_array_elements_text(v_options) LOOP
          v_opt_text := btrim(COALESCE(v_opt_val, ''));

          v_opt_img := '';
          IF v_q ? 'optionImageUrls' AND jsonb_typeof(v_q->'optionImageUrls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'optionImageUrls'->>v_opt_idx, ''));
          ELSIF v_q ? 'option_image_urls' AND jsonb_typeof(v_q->'option_image_urls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'option_image_urls'->>v_opt_idx, ''));
          END IF;
          IF lower(v_opt_img) = 'null' THEN
            v_opt_img := '';
          END IF;

          IF length(v_opt_text) = 0 AND length(v_opt_img) = 0 THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" option % is missing both text and image', v_qid, v_opt_idx + 1;
          END IF;

          IF length(v_opt_text) > 0 AND length(v_opt_img) > 0 THEN
            v_opt_key := 'mixed:' || lower(v_opt_text) || '|img:' || v_opt_img;
          ELSIF length(v_opt_img) > 0 THEN
            v_opt_key := 'img:' || v_opt_img;
          ELSE
            v_opt_key := 'text:' || lower(v_opt_text);
          END IF;

          IF v_opt_key = ANY(v_seen_opts) THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" contains duplicate options (option %)', v_qid, v_opt_idx + 1;
          END IF;
          v_seen_opts := array_append(v_seen_opts, v_opt_key);
          v_opt_idx := v_opt_idx + 1;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;

  IF v_total_questions = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: exam must contain at least one question';
  END IF;

  RETURN NEW;
END;
$$;

-- 3. Raw Table Direct Write Blocker Trigger
-- Closes the raw-table bypass: clients cannot directly mutate cbt_exams_raw or cbt_exam_answers
CREATE OR REPLACE FUNCTION public.block_direct_cbt_exams_raw_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('cbt.trusted_exam_context', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct modification of table % is prohibited. All exam modifications must be executed through the public.cbt_exams view.', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS block_direct_cbt_exams_raw_writes_trigger ON public.cbt_exams_raw;
CREATE TRIGGER block_direct_cbt_exams_raw_writes_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.cbt_exams_raw
  FOR EACH STATEMENT EXECUTE FUNCTION public.block_direct_cbt_exams_raw_writes();

DROP TRIGGER IF EXISTS block_direct_cbt_exam_answers_writes_trigger ON public.cbt_exam_answers;
CREATE TRIGGER block_direct_cbt_exam_answers_writes_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.cbt_exam_answers
  FOR EACH STATEMENT EXECUTE FUNCTION public.block_direct_cbt_exams_raw_writes();

DROP TRIGGER IF EXISTS validate_cbt_exams_raw_trigger ON public.cbt_exams_raw;
CREATE TRIGGER validate_cbt_exams_raw_trigger
  BEFORE INSERT OR UPDATE OF title, questions_data ON public.cbt_exams_raw
  FOR EACH ROW EXECUTE FUNCTION public.validate_cbt_exams_raw_record();

-- 4. Update handle_cbt_exams_modification on view cbt_exams
-- Performs complete validation, sets trusted context, separates answers, and atomically writes
CREATE OR REPLACE FUNCTION public.handle_cbt_exams_modification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clean_questions jsonb := '{}'::jsonb;
  answers_obj jsonb := '{}'::jsonb;
  subject_name text;
  question_obj jsonb;
  clean_subject_questions jsonb;
  clean_qdata jsonb;
  ans_val text;
BEGIN
  IF public.get_my_role() <> 'admin' AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Only administrators can modify exams';
  END IF;

  -- Set trusted context flag for this transaction
  PERFORM set_config('cbt.trusted_exam_context', 'on', true);

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- Deep validation of the complete paper before writing anything
    PERFORM public.validate_full_exam_paper(NEW.title, NEW.questions_data);

    -- Separate answer keys cleanly
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
      VALUES (NEW.id, NEW.title, COALESCE(NEW.status, 'PENDING'), clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, now()));
    ELSE
      UPDATE public.cbt_exams_raw
      SET title = NEW.title, status = NEW.status, questions_data = clean_qdata,
          class = NEW.class, section = NEW.section, created_at = NEW.created_at
      WHERE id = NEW.id;
    END IF;

    INSERT INTO public.cbt_exam_answers (exam_id, answers)
    VALUES (NEW.id, answers_obj)
    ON CONFLICT (exam_id) DO UPDATE SET answers = EXCLUDED.answers;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM public.cbt_exams_raw WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- 5. Revoke direct mutations on raw tables & grant access on protected view
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.cbt_exams_raw FROM anon;';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.cbt_exam_answers FROM anon;';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.cbt_exams_raw FROM authenticated;';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.cbt_exam_answers FROM authenticated;';
    EXECUTE 'GRANT SELECT ON public.cbt_exams_raw TO authenticated;';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.cbt_exams TO authenticated;';
  END IF;
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON public.cbt_exams_raw FROM public;
REVOKE INSERT, UPDATE, DELETE ON public.cbt_exam_answers FROM public;

-- Ensure no policies permit direct writes on raw tables
DROP POLICY IF EXISTS cbt_exams_admin_all ON public.cbt_exams_raw;
DROP POLICY IF EXISTS cbt_exams_admin ON public.cbt_exams_raw;
DROP POLICY IF EXISTS "Allow admin all" ON public.cbt_exams_raw;

DROP POLICY IF EXISTS cbt_exam_answers_admin_only ON public.cbt_exam_answers;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE $pol$
      CREATE POLICY cbt_exam_answers_admin_select ON public.cbt_exam_answers
        FOR SELECT TO authenticated
        USING (public.get_my_role() = 'admin');
    $pol$;
  END IF;
END;
$$;

