-- ============================================================================
-- Migration 20260910260000: Stage 9 — Questions, Imports, and Image Assets
-- - Exam preflight validation asserting question integrity & physical storage presence
-- - Enforce preflight check before an exam can transition to ACTIVE status
-- - Reference-aware storage asset audit and cleanup RPCs
-- ============================================================================

-- 1. Helper Function: Check if an asset is referenced anywhere in exams or question bank
CREATE OR REPLACE FUNCTION public.is_exam_asset_referenced(asset_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
BEGIN
  IF asset_name IS NULL OR length(btrim(asset_name)) = 0 THEN
    RETURN false;
  END IF;

  -- Check if referenced in cbt_exams_raw
  IF EXISTS (
    SELECT 1 FROM public.cbt_exams_raw
    WHERE questions_data::text LIKE '%' || asset_name || '%'
  ) THEN
    RETURN true;
  END IF;

  -- Check if referenced in question_bank
  IF EXISTS (
    SELECT 1 FROM public.question_bank
    WHERE question_image_url = asset_name
       OR (option_image_urls IS NOT NULL AND option_image_urls::text LIKE '%' || asset_name || '%')
       OR question_text LIKE '%' || asset_name || '%'
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.is_exam_asset_referenced(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_exam_asset_referenced(text) TO authenticated;

-- 2. Complete Exam Preflight Validation Function
CREATE OR REPLACE FUNCTION public.preflight_validate_exam(exam_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  qdata jsonb;
  errors text[] := ARRAY[]::text[];
  warnings text[] := ARRAY[]::text[];
  subj text;
  q_item jsonb;
  q_id text;
  q_type text;
  q_text text;
  q_opts jsonb;
  q_img text;
  opt_img text;
  opt_idx integer;
  total_q integer := 0;
  verified_assets integer := 0;
  class_name text;
  section_name text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam not found';
  END IF;

  -- 1. Metadata checks
  IF length(btrim(COALESCE(exam_row.title, ''))) NOT BETWEEN 1 AND 200 THEN
    errors := array_append(errors, 'Exam title must be between 1 and 200 characters');
  END IF;

  class_name := exam_row.class;
  section_name := exam_row.section;
  IF class_name IS NOT NULL AND class_name <> 'All' THEN
    IF NOT EXISTS (SELECT 1 FROM public.classes WHERE name = class_name) THEN
      errors := array_append(errors, format('Target class "%s" does not exist in classes registry', class_name));
    ELSE
      IF section_name IS NOT NULL AND section_name <> 'All' THEN
        IF NOT EXISTS (SELECT 1 FROM public.classes WHERE name = class_name AND section_name = ANY(sections)) THEN
          errors := array_append(errors, format('Target section "%s" is not registered under class "%s"', section_name, class_name));
        END IF;
      END IF;
    END IF;
  END IF;

  qdata := exam_row.questions_data;
  IF qdata IS NULL OR jsonb_typeof(qdata) <> 'object' THEN
    errors := array_append(errors, 'questions_data must be a valid JSON object');
    RETURN jsonb_build_object(
      'valid', false,
      'errors', errors,
      'warnings', warnings,
      'totalQuestions', 0,
      'verifiedAssets', 0
    );
  END IF;

  -- Duration & Marks
  IF COALESCE((qdata->>'duration')::integer, 0) NOT BETWEEN 1 AND 600 THEN
    errors := array_append(errors, 'Duration must be between 1 and 600 minutes');
  END IF;
  IF COALESCE((qdata->>'marksCorrect')::numeric, 0) NOT BETWEEN 0 AND 100 THEN
    errors := array_append(errors, 'Marks for correct answer must be between 0 and 100');
  END IF;
  IF COALESCE((qdata->>'marksIncorrect')::numeric, 0) NOT BETWEEN -100 AND 0 THEN
    errors := array_append(errors, 'Marks for incorrect answer must be between -100 and 0');
  END IF;

  -- Subjects & Questions
  IF jsonb_typeof(qdata->'subjects') <> 'array' OR jsonb_array_length(qdata->'subjects') = 0 THEN
    errors := array_append(errors, 'Exam must contain at least one subject');
  END IF;
  IF jsonb_typeof(qdata->'questions') <> 'object' THEN
    errors := array_append(errors, 'Exam questions object is missing or invalid');
  ELSE
    FOR subj IN SELECT jsonb_object_keys(qdata->'questions') LOOP
      IF jsonb_typeof(qdata->'questions'->subj) <> 'array' THEN
        errors := array_append(errors, format('Subject "%s" questions must be an array', subj));
      ELSE
        FOR q_item IN SELECT value FROM jsonb_array_elements(qdata->'questions'->subj) LOOP
          total_q := total_q + 1;
          q_id := COALESCE(q_item->>'id', format('q-%s', total_q));
          q_type := upper(COALESCE(q_item->>'type', 'MCQ'));
          q_text := btrim(COALESCE(q_item->>'text', ''));
          q_img := btrim(COALESCE(q_item->>'questionImageUrl', q_item->>'imageUrl', ''));

          IF q_text = '' AND q_img = '' THEN
            errors := array_append(errors, format('Question "%s" in %s has neither text nor an image prompt', q_id, subj));
          END IF;
          IF length(q_text) > 10000 THEN
            errors := array_append(errors, format('Question "%s" text exceeds 10,000 characters', q_id));
          END IF;
          IF COALESCE((q_item->>'hasImageOrDiagram')::boolean, false) AND q_img = '' THEN
            errors := array_append(errors, format('Question "%s" is marked as requiring a diagram but no image is attached', q_id));
          END IF;

          -- Image URL checks on prompt image
          IF q_img <> '' THEN
            IF q_img ILIKE 'http://%' THEN
              errors := array_append(errors, format('Question "%s" uses an insecure unencrypted HTTP image URL: %s', q_id, q_img));
            ELSIF q_img ILIKE 'https://%' THEN
              warnings := array_append(warnings, format('Question "%s" uses externally hosted image: %s', q_id, q_img));
            ELSE
              -- Storage path verification
              IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = q_img) THEN
                errors := array_append(errors, format('Question "%s" references missing storage asset: "%s"', q_id, q_img));
              ELSE
                verified_assets := verified_assets + 1;
              END IF;
            END IF;
          END IF;

          -- MCQ Options & option image checks
          IF q_type = 'MCQ' THEN
            q_opts := q_item->'options';
            IF jsonb_typeof(q_opts) <> 'array' OR jsonb_array_length(q_opts) <> 4 THEN
              errors := array_append(errors, format('MCQ Question "%s" must have exactly 4 options', q_id));
            END IF;

            -- Check option images if present
            IF jsonb_typeof(q_item->'optionImageUrls') = 'array' THEN
              FOR opt_idx IN 0..3 LOOP
                opt_img := btrim(COALESCE(q_item->'optionImageUrls'->>opt_idx, ''));
                IF opt_img <> '' THEN
                  IF opt_img ILIKE 'http://%' THEN
                    errors := array_append(errors, format('Question "%s" option %s uses insecure HTTP image URL: %s', q_id, chr(65 + opt_idx), opt_img));
                  ELSIF opt_img ILIKE 'https://%' THEN
                    warnings := array_append(warnings, format('Question "%s" option %s uses externally hosted image: %s', q_id, chr(65 + opt_idx), opt_img));
                  ELSE
                    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = opt_img) THEN
                      errors := array_append(errors, format('Question "%s" option %s references missing storage asset: "%s"', q_id, chr(65 + opt_idx), opt_img));
                    ELSE
                      verified_assets := verified_assets + 1;
                    END IF;
                  END IF;
                END IF;
              END LOOP;
            END IF;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;

  IF total_q = 0 THEN
    errors := array_append(errors, 'The exam paper has zero questions');
  END IF;

  RETURN jsonb_build_object(
    'valid', (cardinality(errors) = 0),
    'errors', to_jsonb(errors),
    'warnings', to_jsonb(warnings),
    'totalQuestions', total_q,
    'verifiedAssets', verified_assets
  );
END;
$$;
REVOKE ALL ON FUNCTION public.preflight_validate_exam(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preflight_validate_exam(uuid) TO authenticated;

-- 3. Reference-Aware Asset Inspection & Cleanup RPCs
CREATE OR REPLACE FUNCTION public.get_unreferenced_exam_assets()
RETURNS TABLE (
  name text,
  id text,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  RETURN QUERY
  SELECT o.name::text, o.id::text, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id = 'exam-assets'
    AND NOT public.is_exam_asset_referenced(o.name);
END;
$$;
REVOKE ALL ON FUNCTION public.get_unreferenced_exam_assets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unreferenced_exam_assets() TO authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_unreferenced_exam_assets()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  unreferenced_names text[] := ARRAY[]::text[];
  deleted_count integer := 0;
  asset_rec RECORD;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  FOR asset_rec IN
    SELECT o.name
    FROM storage.objects o
    WHERE o.bucket_id = 'exam-assets'
      AND NOT public.is_exam_asset_referenced(o.name)
  LOOP
    unreferenced_names := array_append(unreferenced_names, asset_rec.name);
  END LOOP;

  IF cardinality(unreferenced_names) > 0 THEN
    DELETE FROM storage.objects
    WHERE bucket_id = 'exam-assets'
      AND name = ANY(unreferenced_names);
    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    -- Record audit event
    INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (
      auth.uid(),
      'CLEANUP_UNREFERENCED_ASSETS',
      'STORAGE',
      'exam-assets',
      jsonb_build_object(
        'deleted_count', deleted_count,
        'deleted_paths', to_jsonb(unreferenced_names)
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'deleted_count', deleted_count,
    'deleted_paths', to_jsonb(unreferenced_names)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_unreferenced_exam_assets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_unreferenced_exam_assets() TO authenticated;

-- 4. Update handle_cbt_exams_modification to enforce preflight gate on exam activation
CREATE OR REPLACE FUNCTION public.handle_cbt_exams_modification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
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
  preflight_res jsonb;
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

      -- If activating an existing exam, enforce preflight validation
      IF OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
        preflight_res := public.preflight_validate_exam(NEW.id);
        IF NOT (preflight_res->>'valid')::boolean THEN
          RAISE EXCEPTION 'Cannot activate exam "%": preflight validation failed with % error(s). First error: %',
            NEW.title, jsonb_array_length(preflight_res->'errors'), preflight_res->'errors'->>0;
        END IF;
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

    -- If the exam is being inserted or updated into ACTIVE status, verify preflight
    IF NEW.status = 'ACTIVE' THEN
      preflight_res := public.preflight_validate_exam(NEW.id);
      IF NOT (preflight_res->>'valid')::boolean THEN
        RAISE EXCEPTION 'Cannot activate exam "%": preflight validation failed with % error(s). First error: %',
          NEW.title, jsonb_array_length(preflight_res->'errors'), preflight_res->'errors'->>0;
      END IF;
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
