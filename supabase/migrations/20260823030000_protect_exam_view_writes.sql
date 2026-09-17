-- The exam view uses an INSTEAD OF trigger for answer-key separation.  The
-- trigger is security-definer, so it must enforce administrator access itself.

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
BEGIN
  IF public.get_my_role() <> 'admin' AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Only administrators can modify exams';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.questions_data IS NOT NULL AND NEW.questions_data ? 'questions' THEN
      FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
        clean_subject_questions := '[]'::jsonb;
        FOR question_obj IN SELECT jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
          answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object(
            'correct_answer', question_obj->'correctAnswer',
            'subject', subject_name,
            'type', question_obj->>'type'
          ), true);
          clean_subject_questions := clean_subject_questions || (question_obj - 'correctAnswer');
        END LOOP;
        clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
      END LOOP;
      clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);
    ELSE
      clean_qdata := NEW.questions_data;
    END IF;

    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, NEW.status, clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, now()));
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
