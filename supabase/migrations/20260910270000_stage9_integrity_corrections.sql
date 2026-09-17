-- Stage 9 corrections: authoritative activation preflight and safe asset cleanup.
-- Storage files must be deleted through the Storage API. Deleting storage.objects
-- rows directly leaves the underlying object orphaned and is intentionally blocked.

CREATE OR REPLACE FUNCTION public.is_exam_asset_referenced(asset_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN asset_name IS NULL OR length(btrim(asset_name)) = 0 THEN false
    ELSE
      EXISTS (
        SELECT 1
        FROM public.cbt_exams_raw AS exam
        WHERE jsonb_path_exists(
          exam.questions_data,
          '$.** ? (@ == $asset)',
          jsonb_build_object('asset', asset_name)
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.question_bank AS question
        WHERE question.question_image_url = asset_name
           OR EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(
               CASE
                 WHEN jsonb_typeof(question.option_image_urls) = 'array' THEN question.option_image_urls
                 ELSE '[]'::jsonb
               END
             ) AS option_image(value)
             WHERE option_image.value = asset_name
           )
      )
  END;
$$;
REVOKE ALL ON FUNCTION public.is_exam_asset_referenced(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_exam_asset_referenced(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.preflight_validate_exam(exam_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  private_answers jsonb;
  reconstructed_data jsonb;
  errors text[] := ARRAY[]::text[];
  warnings text[] := ARRAY[]::text[];
  seen_question_ids text[] := ARRAY[]::text[];
  declared_subjects text[] := ARRAY[]::text[];
  subject_name text;
  question_item jsonb;
  question_id text;
  question_image text;
  option_image text;
  answer_item jsonb;
  answer_question_id text;
  option_index integer;
  total_questions integer := 0;
  verified_assets integer := 0;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam not found'; END IF;

  IF exam_row.class IS NULL OR length(btrim(exam_row.class)) = 0 THEN
    errors := array_append(errors, 'Target class is required');
  ELSIF exam_row.class <> 'All'
    AND NOT EXISTS (SELECT 1 FROM public.classes WHERE name = exam_row.class) THEN
    errors := array_append(errors, format('Target class "%s" does not exist', exam_row.class));
  END IF;
  IF exam_row.section IS NULL OR length(btrim(exam_row.section)) = 0 THEN
    errors := array_append(errors, 'Target section is required');
  ELSIF exam_row.class <> 'All' AND exam_row.section <> 'All'
    AND NOT EXISTS (
      SELECT 1 FROM public.classes
      WHERE name = exam_row.class AND exam_row.section = ANY(sections)
    ) THEN
    errors := array_append(errors, format('Target section "%s" is not registered under class "%s"', exam_row.section, exam_row.class));
  END IF;

  SELECT answers INTO private_answers FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  IF private_answers IS NULL OR jsonb_typeof(private_answers) <> 'object' THEN
    errors := array_append(errors, 'Private answer key is missing or invalid');
    private_answers := '{}'::jsonb;
  END IF;

  reconstructed_data := public.reconstruct_exam_questions(exam_row.questions_data, private_answers);
  BEGIN
    PERFORM public.validate_full_exam_paper(exam_row.title, reconstructed_data);
  EXCEPTION WHEN OTHERS THEN
    errors := array_append(errors, SQLERRM);
  END;

  IF jsonb_typeof(exam_row.questions_data->'subjects') = 'array' THEN
    FOR subject_name IN SELECT jsonb_array_elements_text(exam_row.questions_data->'subjects') LOOP
      IF subject_name NOT IN ('Physics', 'Chemistry', 'Mathematics') THEN
        errors := array_append(errors, format('Unsupported JEE subject "%s"', subject_name));
      END IF;
      IF lower(btrim(subject_name)) = ANY(declared_subjects) THEN
        errors := array_append(errors, format('Duplicate subject "%s"', subject_name));
      ELSE
        declared_subjects := array_append(declared_subjects, lower(btrim(subject_name)));
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(exam_row.questions_data->'questions') = 'object' THEN
    FOR subject_name IN SELECT jsonb_object_keys(exam_row.questions_data->'questions') LOOP
      IF NOT (lower(btrim(subject_name)) = ANY(declared_subjects)) THEN
        errors := array_append(errors, format('Questions contain undeclared subject "%s"', subject_name));
      END IF;
      IF jsonb_typeof(exam_row.questions_data->'questions'->subject_name) <> 'array' THEN
        errors := array_append(errors, format('Questions for subject "%s" must be an array', subject_name));
        CONTINUE;
      END IF;

      FOR question_item IN SELECT value FROM jsonb_array_elements(exam_row.questions_data->'questions'->subject_name) LOOP
        total_questions := total_questions + 1;
        question_id := btrim(COALESCE(question_item->>'id', ''));
        IF question_id = '' THEN
          errors := array_append(errors, format('Question %s in %s has no stable ID', total_questions, subject_name));
        ELSIF question_id = ANY(seen_question_ids) THEN
          errors := array_append(errors, format('Duplicate question ID "%s"', question_id));
        ELSE
          seen_question_ids := array_append(seen_question_ids, question_id);
        END IF;

        IF question_item ? 'correctAnswer' OR question_item ? 'correct_answer' THEN
          errors := array_append(errors, format('Question "%s" exposes its answer in public exam data', COALESCE(NULLIF(question_id, ''), total_questions::text)));
        END IF;

        answer_item := private_answers->question_id;
        IF question_id <> '' AND answer_item IS NULL THEN
          errors := array_append(errors, format('Question "%s" has no private answer-key entry', question_id));
        ELSIF answer_item IS NOT NULL AND (
          answer_item->>'subject' IS DISTINCT FROM subject_name
          OR upper(COALESCE(answer_item->>'type', '')) IS DISTINCT FROM upper(COALESCE(question_item->>'type', 'MCQ'))
        ) THEN
          errors := array_append(errors, format('Question "%s" answer metadata does not match the public paper', question_id));
        END IF;

        question_image := btrim(COALESCE(question_item->>'questionImageUrl', question_item->>'imageUrl', ''));
        IF question_image <> '' THEN
          IF question_image ~* '^https?://' OR question_image ~* '^data:' THEN
            errors := array_append(errors, format('Question "%s" must use a private exam-assets path, not an external or embedded image', question_id));
          ELSIF NOT EXISTS (
            SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = question_image
          ) THEN
            errors := array_append(errors, format('Question "%s" references missing storage asset: "%s"', question_id, question_image));
          ELSE
            verified_assets := verified_assets + 1;
          END IF;
        END IF;

        IF jsonb_typeof(question_item->'optionImageUrls') = 'array' THEN
          FOR option_index IN 0..jsonb_array_length(question_item->'optionImageUrls') - 1 LOOP
            option_image := btrim(COALESCE(question_item->'optionImageUrls'->>option_index, ''));
            IF option_image = '' OR lower(option_image) = 'null' THEN CONTINUE; END IF;
            IF option_image ~* '^https?://' OR option_image ~* '^data:' THEN
              errors := array_append(errors, format('Question "%s" option %s must use a private exam-assets path', question_id, option_index + 1));
            ELSIF NOT EXISTS (
              SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = option_image
            ) THEN
              errors := array_append(errors, format('Question "%s" option %s references missing storage asset: "%s"', question_id, option_index + 1, option_image));
            ELSE
              verified_assets := verified_assets + 1;
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  FOR answer_question_id IN SELECT jsonb_object_keys(private_answers) LOOP
    IF NOT (answer_question_id = ANY(seen_question_ids)) THEN
      errors := array_append(errors, format('Private answer key contains unknown question ID "%s"', answer_question_id));
    END IF;
  END LOOP;

  IF total_questions = 0 THEN errors := array_append(errors, 'The exam paper has zero questions'); END IF;

  RETURN jsonb_build_object(
    'valid', cardinality(errors) = 0,
    'errors', to_jsonb(errors),
    'warnings', to_jsonb(warnings),
    'totalQuestions', total_questions,
    'verifiedAssets', verified_assets
  );
END;
$$;
REVOKE ALL ON FUNCTION public.preflight_validate_exam(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preflight_validate_exam(uuid) TO authenticated;

-- Disable the unsafe metadata-only deletion RPC left by the preceding migration.
CREATE OR REPLACE FUNCTION public.cleanup_unreferenced_exam_assets()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Direct database cleanup is disabled; delete files through the Supabase Storage API';
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_unreferenced_exam_assets() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_exam_asset_cleanup(asset_names text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage, pg_temp
AS $$
DECLARE
  normalized_names text[];
  asset_name text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  SELECT array_agg(DISTINCT btrim(value) ORDER BY btrim(value))
    INTO normalized_names
    FROM unnest(asset_names) AS supplied(value)
    WHERE value IS NOT NULL AND length(btrim(value)) BETWEEN 1 AND 1024;
  IF COALESCE(cardinality(normalized_names), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Cleanup audit requires between 1 and 100 valid asset paths';
  END IF;
  FOREACH asset_name IN ARRAY normalized_names LOOP
    IF public.is_exam_asset_referenced(asset_name) THEN
      RAISE EXCEPTION 'Asset "%" is now referenced and cannot be recorded as deleted', asset_name;
    END IF;
    IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = asset_name) THEN
      RAISE EXCEPTION 'Asset "%" still exists in storage and was not deleted', asset_name;
    END IF;
  END LOOP;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'CLEANUP_UNREFERENCED_ASSETS', 'STORAGE', 'exam-assets',
    jsonb_build_object('deleted_count', cardinality(normalized_names), 'deleted_paths', to_jsonb(normalized_names)));
  RETURN jsonb_build_object('deleted_count', cardinality(normalized_names), 'deleted_paths', to_jsonb(normalized_names));
END;
$$;
REVOKE ALL ON FUNCTION public.record_exam_asset_cleanup(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_exam_asset_cleanup(text[]) TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
    DROP POLICY IF EXISTS exam_assets_admin_delete_aal2 ON storage.objects;
    CREATE POLICY exam_assets_admin_delete_aal2 ON storage.objects
      FOR DELETE TO authenticated
      USING (
        bucket_id = 'exam-assets'
        AND public.is_admin_aal2()
        AND NOT public.is_exam_asset_referenced(name)
      );
  END IF;
END;
$$;

-- Ensure answer keys exist before activation preflight runs for newly-created or
-- edited ACTIVE papers. A failed preflight rolls the entire view mutation back.
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
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to modify exams'; END IF;
  PERFORM set_config('cbt.trusted_exam_context', 'on', true);
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status NOT IN ('PENDING', 'ACTIVE', 'ENDED') THEN RAISE EXCEPTION 'Invalid exam lifecycle status'; END IF;
  IF TG_OP = 'UPDATE' THEN
    has_attempts := EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text)
                 OR EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text);
    IF has_attempts AND OLD.status = 'ENDED' AND NEW.status <> 'ENDED' THEN RAISE EXCEPTION 'Cannot reactivate an ended exam that has student attempts or results'; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'PENDING' AND NEW.status = 'ACTIVE') OR (OLD.status = 'ACTIVE' AND NEW.status = 'ENDED')
      OR (OLD.status = 'ENDED' AND NEW.status = 'ACTIVE' AND NOT has_attempts)
    ) THEN RAISE EXCEPTION 'Invalid exam lifecycle transition from % to %', OLD.status, NEW.status; END IF;
    IF has_attempts AND (OLD.questions_data IS DISTINCT FROM NEW.questions_data OR OLD.class IS DISTINCT FROM NEW.class OR OLD.section IS DISTINCT FROM NEW.section) THEN
      RAISE EXCEPTION 'Cannot modify exam questions, duration, scoring, or assignment after student attempts have begun';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_OP = 'UPDATE' AND NEW.questions_data IS NOT DISTINCT FROM OLD.questions_data THEN
      IF NEW.title IS NULL OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters'; END IF;
      IF OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
        preflight_res := public.preflight_validate_exam(NEW.id);
        IF NOT (preflight_res->>'valid')::boolean THEN
          RAISE EXCEPTION 'Cannot activate exam "%": preflight validation failed with % error(s). First error: %', NEW.title, jsonb_array_length(preflight_res->'errors'), preflight_res->'errors'->>0;
        END IF;
      END IF;
      UPDATE public.cbt_exams_raw SET title = NEW.title, status = NEW.status, questions_data = OLD.questions_data, class = NEW.class, section = NEW.section WHERE id = NEW.id;
      RETURN NEW;
    END IF;
    PERFORM public.validate_full_exam_paper(NEW.title, NEW.questions_data);
    FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
      clean_subject_questions := '[]'::jsonb;
      FOR question_obj IN SELECT value FROM jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
        ans_val := btrim(COALESCE(question_obj->>'correctAnswer', question_obj->>'correct_answer', ''));
        IF upper(ans_val) IN ('A', 'B', 'C', 'D') THEN ans_val := (ascii(upper(ans_val)) - 65)::text; END IF;
        answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object('correct_answer', ans_val, 'subject', subject_name, 'type', upper(COALESCE(question_obj->>'type', 'MCQ'))), true);
        clean_subject_questions := clean_subject_questions || jsonb_build_array(question_obj - 'correctAnswer' - 'correct_answer');
      END LOOP;
      clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
    END LOOP;
    clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);
    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, COALESCE(NEW.status, 'PENDING'), clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, clock_timestamp()));
    ELSE
      UPDATE public.cbt_exams_raw SET title = NEW.title, status = NEW.status, questions_data = clean_qdata, class = NEW.class, section = NEW.section WHERE id = NEW.id;
    END IF;
    INSERT INTO public.cbt_exam_answers (exam_id, answers) VALUES (NEW.id, answers_obj)
      ON CONFLICT (exam_id) DO UPDATE SET answers = EXCLUDED.answers;
    IF NEW.status = 'ACTIVE' THEN
      preflight_res := public.preflight_validate_exam(NEW.id);
      IF NOT (preflight_res->>'valid')::boolean THEN
        RAISE EXCEPTION 'Cannot activate exam "%": preflight validation failed with % error(s). First error: %', NEW.title, jsonb_array_length(preflight_res->'errors'), preflight_res->'errors'->>0;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ACTIVE' THEN RAISE EXCEPTION 'Cannot delete an active exam. End the exam first.'; END IF;
    IF EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text) THEN RAISE EXCEPTION 'Cannot delete exam % because student submission results exist', OLD.id; END IF;
    IF EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text) THEN RAISE EXCEPTION 'Cannot delete exam % because active student attempts exist', OLD.id; END IF;
    DELETE FROM public.cbt_exams_raw WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.handle_cbt_exams_modification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_cbt_exams_modification() TO authenticated;
