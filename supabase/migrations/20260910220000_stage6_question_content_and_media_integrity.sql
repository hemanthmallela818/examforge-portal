-- Stage 6B: manual question validation and required-media exam gate.

CREATE OR REPLACE FUNCTION public.validate_question_bank_content()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  option_index integer;
  option_text text;
  option_image text;
  option_key text;
  seen_keys text[] := ARRAY[]::text[];
BEGIN
  NEW.subject := btrim(NEW.subject);
  NEW.type := upper(NEW.type);
  NEW.question_text := btrim(NEW.question_text);
  NEW.correct_answer := btrim(NEW.correct_answer);

  IF NEW.subject NOT IN ('Physics', 'Chemistry', 'Mathematics') THEN
    RAISE EXCEPTION 'Question subject must be Physics, Chemistry, or Mathematics';
  END IF;
  IF NEW.type NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN RAISE EXCEPTION 'Question type is invalid'; END IF;
  IF length(NEW.question_text) > 10000 THEN RAISE EXCEPTION 'Question text must not exceed 10000 characters'; END IF;
  IF NEW.question_text = '' AND length(btrim(COALESCE(NEW.question_image_url, ''))) = 0 THEN
    RAISE EXCEPTION 'Question text or a question image is required';
  END IF;
  IF NEW.question_image_url IS NOT NULL AND length(NEW.question_image_url) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'Question image reference is invalid';
  END IF;

  IF NEW.type = 'MCQ' THEN
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 4
       OR NEW.correct_answer !~ '^[0-3]$' THEN
      RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
    END IF;
    IF NEW.option_image_urls IS NOT NULL
       AND (jsonb_typeof(NEW.option_image_urls) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.option_image_urls) <> 4) THEN
      RAISE EXCEPTION 'MCQ option image references must contain exactly four positions';
    END IF;
    FOR option_index IN 0..3 LOOP
      IF jsonb_typeof(NEW.options->option_index) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Every MCQ option text value must be a string';
      END IF;
      option_text := btrim(COALESCE(NEW.options->>option_index, ''));
      option_image := btrim(COALESCE(NEW.option_image_urls->>option_index, ''));
      IF length(option_text) > 5000 THEN RAISE EXCEPTION 'MCQ option text must not exceed 5000 characters'; END IF;
      IF length(option_image) > 2048 THEN RAISE EXCEPTION 'MCQ option image reference is too long'; END IF;
      IF option_text = '' AND option_image = '' THEN RAISE EXCEPTION 'Every MCQ option requires text or an image'; END IF;
      option_key := CASE WHEN option_image <> '' THEN 'img:' || option_image ELSE 'text:' || public.canonical_question_text(option_text) END;
      IF option_key = ANY(seen_keys) THEN RAISE EXCEPTION 'MCQ options must be unique'; END IF;
      seen_keys := array_append(seen_keys, option_key);
    END LOOP;
  ELSE
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 0
       OR length(NEW.correct_answer) NOT BETWEEN 1 AND 100
       OR NEW.correct_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
      RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
    END IF;
    IF NEW.option_image_urls IS NOT NULL AND NEW.option_image_urls <> '[]'::jsonb
       AND NEW.option_image_urls <> '[null, null, null, null]'::jsonb THEN
      RAISE EXCEPTION 'Numerical questions cannot retain option images';
    END IF;
    NEW.option_image_urls := '[]'::jsonb;
  END IF;
  NEW.has_image_or_diagram := COALESCE(NEW.has_image_or_diagram, false) OR NEW.question_image_url IS NOT NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_question_bank_content_trigger ON public.question_bank;
CREATE TRIGGER validate_question_bank_content_trigger
  BEFORE INSERT OR UPDATE ON public.question_bank
  FOR EACH ROW EXECUTE FUNCTION public.validate_question_bank_content();
REVOKE ALL ON FUNCTION public.validate_question_bank_content() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.assert_exam_required_media(questions_data_param jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  subject_name text;
  question_item jsonb;
BEGIN
  IF jsonb_typeof(questions_data_param->'questions') IS DISTINCT FROM 'object' THEN RETURN; END IF;
  FOR subject_name IN SELECT jsonb_object_keys(questions_data_param->'questions') LOOP
    FOR question_item IN SELECT value FROM jsonb_array_elements(questions_data_param->'questions'->subject_name) LOOP
      IF COALESCE((question_item->>'hasImageOrDiagram')::boolean, false)
         AND length(btrim(COALESCE(question_item->>'questionImageUrl', question_item->>'imageUrl', ''))) = 0 THEN
        RAISE EXCEPTION 'Exam validation failed: question "%" is marked as requiring an image or diagram but none is attached', COALESCE(question_item->>'id', 'unknown');
      END IF;
    END LOOP;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_exam_required_media(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.validate_exam_required_media_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_exam_required_media(NEW.questions_data);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_exam_required_media_record() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_exam_required_media_trigger ON public.cbt_exams_raw;
CREATE TRIGGER validate_exam_required_media_trigger
  BEFORE INSERT OR UPDATE OF questions_data ON public.cbt_exams_raw
  FOR EACH ROW EXECUTE FUNCTION public.validate_exam_required_media_record();
