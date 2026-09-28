-- More question types: multiple correct (with partial marks), integer, matrix
-- match, assertion-reason, and paragraph sets.
-- Design: docs/superpowers/specs/2026-09-28-question-types-design.md
--
-- 1. Shared helpers hold each rule once: supported types, author answer
--    grammar, question details (match lists / paragraph), candidate answer
--    grammar, marking resolution, and scoring.
-- 2. question_bank gains a nullable details column; duplicate detection
--    includes it, so repeated matrix-match stems and paragraph follow-ups
--    are not rejected as copies of each other.
-- 3. Exams may carry per-type marking (questions_data.marking); exam patterns
--    may carry the same. Missing entries fall back to marksCorrect /
--    marksIncorrect, so existing exams grade exactly as before.
-- 4. The start-of-exam shuffle moves a paragraph's questions as one block.
-- 5. Grading counts partial answers and stores exactly what it graded, keyed by
--    question ID, for the administrator answer review.

BEGIN;

-- ---------------------------------------------------------------------------
-- Shared, data-free helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.question_type_is_option_based(question_type pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT pg_catalog.upper(COALESCE(question_type, 'MCQ'))
    IN ('MCQ', 'MULTIPLE_CORRECT', 'MATRIX_MATCH', 'ASSERTION_REASON')
$function$;

CREATE OR REPLACE FUNCTION public.question_type_is_supported(question_type pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT pg_catalog.upper(COALESCE(question_type, 'MCQ'))
    IN ('MCQ', 'MULTIPLE_CORRECT', 'MATRIX_MATCH', 'ASSERTION_REASON', 'INTEGER', 'NUMERICAL', 'NAT')
$function$;

-- A multiple-correct value is canonical when it lists 1+ distinct option
-- indices below option_count, strictly increasing and comma separated ("0,2").
CREATE OR REPLACE FUNCTION public.is_canonical_option_set(value pg_catalog.text, option_count pg_catalog.int4)
RETURNS pg_catalog.bool
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  part pg_catalog.text;
  previous pg_catalog.int4 := -1;
BEGIN
  IF value IS NULL OR value !~ '^[0-9](,[0-9]){0,9}$' THEN
    RETURN false;
  END IF;
  FOREACH part IN ARRAY pg_catalog.string_to_array(value, ',') LOOP
    IF part::pg_catalog.int4 OPERATOR(pg_catalog.<=) previous
      OR part::pg_catalog.int4 OPERATOR(pg_catalog.>=) COALESCE(option_count, 0)
    THEN
      RETURN false;
    END IF;
    previous := part::pg_catalog.int4;
  END LOOP;
  RETURN true;
END;
$function$;

-- Author-side correct answer grammar per type (MCQ-like types store 0-3).
CREATE OR REPLACE FUNCTION public.is_valid_correct_answer(question_type pg_catalog.text, answer pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE pg_catalog.upper(COALESCE(question_type, 'MCQ'))
    WHEN 'MULTIPLE_CORRECT' THEN public.is_canonical_option_set(answer, 4)
    WHEN 'INTEGER' THEN COALESCE(answer ~ '^[+-]?[0-9]+$' AND pg_catalog.length(answer) OPERATOR(pg_catalog.<=) 100, false)
    WHEN 'NUMERICAL' THEN COALESCE(answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$', false)
    WHEN 'NAT' THEN COALESCE(answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$', false)
    ELSE COALESCE(answer ~ '^[0-3]$', false)
  END
$function$;

-- NULL when details are valid for the type, otherwise the reason.
CREATE OR REPLACE FUNCTION public.question_details_error(question_type pg_catalog.text, details pg_catalog.jsonb)
RETURNS pg_catalog.text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  is_matrix pg_catalog.bool := pg_catalog.upper(COALESCE(question_type, 'MCQ')) OPERATOR(pg_catalog.=) 'MATRIX_MATCH';
  list_name pg_catalog.text;
  list_value pg_catalog.jsonb;
  max_items pg_catalog.int4;
  item pg_catalog.jsonb;
  passage pg_catalog.jsonb;
BEGIN
  IF details IS NULL OR pg_catalog.jsonb_typeof(details) OPERATOR(pg_catalog.=) 'null' THEN
    RETURN CASE WHEN is_matrix THEN 'Matrix match questions require List-I and List-II' END;
  END IF;
  IF pg_catalog.jsonb_typeof(details) OPERATOR(pg_catalog.<>) 'object' THEN
    RETURN 'Question details must be an object';
  END IF;
  IF pg_catalog.octet_length(details::pg_catalog.text) OPERATOR(pg_catalog.>) 32768 THEN
    RETURN 'Question details must not exceed 32 KiB';
  END IF;
  IF (details OPERATOR(pg_catalog.-) ARRAY['matchLists', 'passage']::pg_catalog.text[])
    OPERATOR(pg_catalog.<>) '{}'::pg_catalog.jsonb
  THEN
    RETURN 'Question details contain unsupported fields';
  END IF;

  IF details OPERATOR(pg_catalog.?) 'matchLists' THEN
    IF NOT is_matrix THEN
      RETURN 'Only matrix match questions can have List-I and List-II';
    END IF;
    IF pg_catalog.jsonb_typeof(details -> 'matchLists') IS DISTINCT FROM 'object'
      OR ((details -> 'matchLists') OPERATOR(pg_catalog.-) ARRAY['left', 'right']::pg_catalog.text[])
        OPERATOR(pg_catalog.<>) '{}'::pg_catalog.jsonb
    THEN
      RETURN 'List-I and List-II are invalid';
    END IF;
    FOREACH list_name IN ARRAY ARRAY['left', 'right'] LOOP
      list_value := details -> 'matchLists' -> list_name;
      max_items := CASE WHEN list_name OPERATOR(pg_catalog.=) 'left' THEN 6 ELSE 8 END;
      IF pg_catalog.jsonb_typeof(list_value) IS DISTINCT FROM 'array'
        OR pg_catalog.jsonb_array_length(list_value) OPERATOR(pg_catalog.<) 2
        OR pg_catalog.jsonb_array_length(list_value) OPERATOR(pg_catalog.>) max_items
      THEN
        RETURN CASE WHEN list_name OPERATOR(pg_catalog.=) 'left'
          THEN 'List-I must have 2 to 6 items'
          ELSE 'List-II must have 2 to 8 items' END;
      END IF;
      FOR item IN SELECT element.value FROM pg_catalog.jsonb_array_elements(list_value) AS element LOOP
        IF pg_catalog.jsonb_typeof(item) OPERATOR(pg_catalog.<>) 'string'
          OR pg_catalog.length(pg_catalog.btrim(item #>> '{}')) NOT BETWEEN 1 AND 2000
        THEN
          RETURN 'Every List-I and List-II item needs 1 to 2000 characters';
        END IF;
      END LOOP;
    END LOOP;
  ELSIF is_matrix THEN
    RETURN 'Matrix match questions require List-I and List-II';
  END IF;

  IF details OPERATOR(pg_catalog.?) 'passage' THEN
    passage := details -> 'passage';
    IF pg_catalog.jsonb_typeof(passage) IS DISTINCT FROM 'object'
      OR (passage OPERATOR(pg_catalog.-) ARRAY['key', 'text']::pg_catalog.text[])
        OPERATOR(pg_catalog.<>) '{}'::pg_catalog.jsonb
      OR COALESCE(passage ->> 'key', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR pg_catalog.jsonb_typeof(passage -> 'text') IS DISTINCT FROM 'string'
      OR pg_catalog.length(pg_catalog.btrim(passage ->> 'text')) NOT BETWEEN 1 AND 10000
    THEN
      RETURN 'The paragraph must have a valid key and 1 to 10000 characters of text';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

-- Duplicate-detection key: the canonical text plus the structured content
-- (match lists, paragraph), so shared stems do not collide.
CREATE OR REPLACE FUNCTION public.question_identity_key(question_text pg_catalog.text, details pg_catalog.jsonb)
RETURNS pg_catalog.text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT public.canonical_question_text(question_text)
    OPERATOR(pg_catalog.||) '|'
    OPERATOR(pg_catalog.||) COALESCE(details::pg_catalog.text, '')
$function$;

REVOKE ALL ON FUNCTION public.question_type_is_option_based(pg_catalog.text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.question_type_is_supported(pg_catalog.text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_canonical_option_set(pg_catalog.text, pg_catalog.int4) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_valid_correct_answer(pg_catalog.text, pg_catalog.text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.question_details_error(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.question_identity_key(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, anon;
-- The question bank trigger and CHECK constraint run as the calling
-- administrator. These helpers read no data.
GRANT EXECUTE ON FUNCTION public.question_type_is_option_based(pg_catalog.text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.question_type_is_supported(pg_catalog.text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_canonical_option_set(pg_catalog.text, pg_catalog.int4) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_correct_answer(pg_catalog.text, pg_catalog.text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.question_details_error(pg_catalog.text, pg_catalog.jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.question_identity_key(pg_catalog.text, pg_catalog.jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Question bank storage
-- ---------------------------------------------------------------------------

ALTER TABLE public.question_bank ADD COLUMN IF NOT EXISTS details pg_catalog.jsonb;

ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_data_valid;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_data_valid CHECK (
  public.question_type_is_supported(type)
  AND type OPERATOR(pg_catalog.=) pg_catalog.upper(type)
  AND pg_catalog.length(pg_catalog.btrim(subject)) BETWEEN 1 AND 120
  AND pg_catalog.jsonb_typeof(options) OPERATOR(pg_catalog.=) 'array'
  AND pg_catalog.jsonb_array_length(options) OPERATOR(pg_catalog.=)
    CASE WHEN public.question_type_is_option_based(type) THEN 4 ELSE 0 END
  AND public.is_valid_correct_answer(type, correct_answer)
  AND public.question_details_error(type, details) IS NULL
) NOT VALID;
ALTER TABLE public.question_bank VALIDATE CONSTRAINT question_bank_data_valid;

DROP INDEX IF EXISTS public.question_bank_canonical_text_unique;
CREATE UNIQUE INDEX question_bank_identity_unique
  ON public.question_bank (pg_catalog.md5(public.question_identity_key(question_text, details)))
  WHERE public.canonical_question_text(question_text) OPERATOR(pg_catalog.<>) '';

CREATE OR REPLACE FUNCTION public.validate_question_bank_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  option_index integer;
  option_text text;
  option_image text;
  option_key text;
  seen_keys text[] := ARRAY[]::text[];
  canonical_subject text;
  details_error text;
BEGIN
  NEW.subject := btrim(NEW.subject);
  NEW.type := upper(NEW.type);
  NEW.question_text := btrim(NEW.question_text);
  NEW.correct_answer := btrim(NEW.correct_answer);
  IF NEW.details IS NOT NULL AND (jsonb_typeof(NEW.details) = 'null' OR NEW.details = '{}'::jsonb) THEN
    NEW.details := NULL;
  END IF;

  -- Subjects are administrator-configured. New questions, and questions moved to
  -- another subject, must use an active subject; existing questions keep working
  -- after their subject is deactivated.
  IF TG_OP = 'INSERT' OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    canonical_subject := public.resolve_active_subject(NEW.subject);
    IF canonical_subject IS NULL THEN
      RAISE EXCEPTION 'Question subject "%" is not an active subject. Add or reactivate it under Subjects & Patterns.', NEW.subject;
    END IF;
    NEW.subject := canonical_subject;
  END IF;
  IF NOT public.question_type_is_supported(NEW.type) THEN RAISE EXCEPTION 'Question type is invalid'; END IF;
  IF length(NEW.question_text) > 10000 THEN RAISE EXCEPTION 'Question text must not exceed 10000 characters'; END IF;
  IF NEW.question_text = '' AND length(btrim(COALESCE(NEW.question_image_url, ''))) = 0 THEN
    RAISE EXCEPTION 'Question text or a question image is required';
  END IF;
  IF NEW.question_image_url IS NOT NULL AND length(NEW.question_image_url) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'Question image reference is invalid';
  END IF;

  IF public.question_type_is_option_based(NEW.type) THEN
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 4
       OR NOT public.is_valid_correct_answer(NEW.type, NEW.correct_answer) THEN
      IF NEW.type = 'MCQ' THEN
        RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
      END IF;
      RAISE EXCEPTION '% requires four options and a valid correct answer', NEW.type;
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
       OR NOT public.is_valid_correct_answer(NEW.type, NEW.correct_answer) THEN
      IF NEW.type = 'INTEGER' THEN
        RAISE EXCEPTION 'Integer questions require no options and a whole-number answer';
      END IF;
      RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
    END IF;
    IF NEW.option_image_urls IS NOT NULL AND NEW.option_image_urls <> '[]'::jsonb
       AND NEW.option_image_urls <> '[null, null, null, null]'::jsonb THEN
      RAISE EXCEPTION 'Numerical questions cannot retain option images';
    END IF;
    NEW.option_image_urls := '[]'::jsonb;
  END IF;

  details_error := public.question_details_error(NEW.type, NEW.details);
  IF details_error IS NOT NULL THEN
    RAISE EXCEPTION '%', details_error;
  END IF;
  IF NEW.details IS NOT NULL AND NEW.details ? 'passage' THEN
    NEW.details := jsonb_set(NEW.details, '{passage,text}', to_jsonb(btrim(NEW.details #>> '{passage,text}')));
  END IF;

  NEW.has_image_or_diagram := COALESCE(NEW.has_image_or_diagram, false) OR NEW.question_image_url IS NOT NULL;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Question import and bank reads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_import_questions(batch_id_param uuid, file_name_param text, questions_param jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  item jsonb;
  option_value jsonb;
  item_type text;
  item_subject text;
  item_text text;
  item_answer text;
  item_options jsonb;
  item_details jsonb;
  details_error text;
  item_count integer;
  request_hash text;
  existing_batch public.question_import_batches%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF batch_id_param IS NULL THEN RAISE EXCEPTION 'Import batch ID is required'; END IF;
  IF length(btrim(COALESCE(file_name_param, ''))) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'File name must contain between 1 and 255 characters';
  END IF;
  IF jsonb_typeof(questions_param) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Questions payload must be a JSON array';
  END IF;
  item_count := jsonb_array_length(questions_param);
  IF item_count NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Import must contain between 1 and 500 questions'; END IF;
  IF octet_length(convert_to(questions_param::text, 'UTF8')) > 5242880 THEN
    RAISE EXCEPTION 'Import payload must not exceed 5 MB';
  END IF;

  request_hash := md5(questions_param::text);
  LOCK TABLE public.question_import_batches IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO existing_batch FROM public.question_import_batches WHERE batch_id = batch_id_param;
  IF FOUND THEN
    IF existing_batch.imported_by IS DISTINCT FROM actor_id OR existing_batch.payload_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Import batch ID was already used for a different request';
    END IF;
    RETURN jsonb_build_object('imported', existing_batch.question_count, 'idempotent', true, 'batch_id', batch_id_param);
  END IF;

  LOCK TABLE public.question_bank IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('cbt.question_import_batch', 'on', true);
  FOR item IN SELECT value FROM jsonb_array_elements(questions_param) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Every question must be a JSON object'; END IF;
    IF (item - ARRAY['subject','type','question_text','options','correct_answer','has_image_or_diagram','category','points','neg_points','details']::text[]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Question contains unsupported fields';
    END IF;
    item_type := item->>'type';
    item_subject := item->>'subject';
    item_text := btrim(COALESCE(item->>'question_text', ''));
    item_answer := btrim(COALESCE(item->>'correct_answer', ''));
    item_options := item->'options';
    IF item ? 'details' AND jsonb_typeof(item->'details') NOT IN ('object', 'null') THEN
      RAISE EXCEPTION 'Question details must be an object';
    END IF;
    item_details := CASE
      WHEN jsonb_typeof(item->'details') = 'object' AND item->'details' <> '{}'::jsonb THEN item->'details'
    END;

    SELECT configured.name INTO item_subject
    FROM public.subjects AS configured
    WHERE lower(configured.name) = lower(btrim(COALESCE(item->>'subject', ''))) AND configured.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid question subject'; END IF;
    IF item_type IS NULL OR item_type NOT IN ('MCQ', 'NUMERICAL', 'MULTIPLE_CORRECT', 'INTEGER', 'MATRIX_MATCH', 'ASSERTION_REASON') THEN
      RAISE EXCEPTION 'Invalid question type';
    END IF;
    IF length(item_text) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Question text must contain between 1 and 10000 characters'; END IF;
    IF jsonb_typeof(item->'has_image_or_diagram') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Image indicator must be boolean'; END IF;
    IF COALESCE((item->>'points')::integer, 0) <> 4 OR COALESCE((item->>'neg_points')::integer, 0) <> -1 THEN
      RAISE EXCEPTION 'Imported JEE questions must use +4/-1 scoring';
    END IF;

    IF public.question_type_is_option_based(item_type) THEN
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 4
         OR NOT public.is_valid_correct_answer(item_type, item_answer) THEN
        IF item_type = 'MCQ' THEN
          RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
        END IF;
        RAISE EXCEPTION '% requires four options and a valid correct answer', item_type;
      END IF;
      FOR option_value IN SELECT value FROM jsonb_array_elements(item_options) LOOP
        IF jsonb_typeof(option_value) IS DISTINCT FROM 'string'
           OR length(btrim(option_value #>> '{}')) NOT BETWEEN 1 AND 5000 THEN
          RAISE EXCEPTION 'Every MCQ option must contain between 1 and 5000 characters';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT public.canonical_question_text(value #>> '{}')) FROM jsonb_array_elements(item_options)) <> 4 THEN
        RAISE EXCEPTION 'MCQ options must be unique';
      END IF;
    ELSE
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 0
         OR length(item_answer) NOT BETWEEN 1 AND 100
         OR NOT public.is_valid_correct_answer(item_type, item_answer) THEN
        IF item_type = 'INTEGER' THEN
          RAISE EXCEPTION 'Integer questions require no options and a whole-number answer';
        END IF;
        RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
      END IF;
    END IF;

    details_error := public.question_details_error(item_type, item_details);
    IF details_error IS NOT NULL THEN
      RAISE EXCEPTION '%', details_error;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.question_bank AS existing
      WHERE public.canonical_question_text(existing.question_text) <> ''
        AND md5(public.question_identity_key(existing.question_text, existing.details))
          = md5(public.question_identity_key(item_text, item_details))
    ) THEN
      RAISE EXCEPTION 'A matching question already exists in the Question Bank';
    END IF;

    INSERT INTO public.question_bank (
      subject, type, question_text, options, correct_answer, has_image_or_diagram, category, points, neg_points, details
    ) VALUES (
      item_subject, item_type, item_text, item_options, item_answer,
      (item->>'has_image_or_diagram')::boolean, COALESCE(NULLIF(btrim(item->>'category'), ''), 'Mains'), 4, -1, item_details
    );
  END LOOP;

  INSERT INTO public.question_import_batches (batch_id, imported_by, payload_hash, file_name, question_count)
  VALUES (batch_id_param, actor_id, request_hash, btrim(file_name_param), item_count);
  INSERT INTO public.import_history (file_name, total_questions, successful_imports, rejected_questions, status)
  VALUES (btrim(file_name_param), item_count, item_count, 0, 'Success');
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (actor_id, 'IMPORT_QUESTIONS', 'question_import_batch', batch_id_param::text,
          jsonb_build_object('file_name', btrim(file_name_param), 'question_count', item_count));

  RETURN jsonb_build_object('imported', item_count, 'idempotent', false, 'batch_id', batch_id_param);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_question_bank_page(page_number_param integer, page_size_param integer, search_param text DEFAULT NULL::text, subject_param text DEFAULT NULL::text, type_param text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  normalized_subject text := NULLIF(btrim(COALESCE(subject_param, '')), '');
  normalized_type text := NULLIF(upper(btrim(COALESCE(type_param, ''))), '');
  total_count integer;
  page_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 200';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Question search must not exceed 100 characters';
  END IF;
  IF normalized_subject IS NOT NULL AND length(normalized_subject) > 100 THEN
    RAISE EXCEPTION 'Subject filter must not exceed 100 characters';
  END IF;
  IF normalized_type IS NOT NULL AND NOT public.question_type_is_supported(normalized_type) THEN
    RAISE EXCEPTION 'Question type filter is invalid';
  END IF;
  IF normalized_type = 'NAT' THEN
    normalized_type := 'NUMERICAL';
  END IF;

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  )
  SELECT count(*)::integer INTO total_count
  FROM numbered question
  WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
    AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE upper(question.type) END = normalized_type)
    AND (
      normalized_search IS NULL
      OR position(lower(normalized_search) in lower(question.question_text)) > 0
      OR position(lower(normalized_search) in lower(question.subject)) > 0
      OR position(normalized_search in question.question_number::text) > 0
    );

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  ), filtered AS (
    SELECT question.*,
      COALESCE((
        SELECT configured.display_order FROM public.subjects AS configured
        WHERE lower(configured.name) = lower(question.subject)
      ), 1000000) AS subject_sort
    FROM numbered question
    WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
      AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE upper(question.type) END = normalized_type)
      AND (
        normalized_search IS NULL
        OR position(lower(normalized_search) in lower(question.question_text)) > 0
        OR position(lower(normalized_search) in lower(question.subject)) > 0
        OR position(normalized_search in question.question_number::text) > 0
      )
  )
  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.subject_sort, page_row.subject, page_row.question_number, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT question.subject_sort, question.subject, question.question_number, question.id,
      jsonb_build_object(
        'id', question.id,
        'subject', question.subject,
        'type', question.type,
        'question_number', question.question_number,
        'question_text', question.question_text,
        'options', question.options,
        'correct_answer', question.correct_answer,
        'question_image_url', question.question_image_url,
        'option_image_urls', question.option_image_urls,
        'has_image_or_diagram', question.has_image_or_diagram,
        'details', question.details,
        'created_at', question.created_at
      ) AS payload
    FROM filtered question
    ORDER BY question.subject_sort, question.subject, question.question_number, question.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object('page', page_number_param, 'page_size', page_size_param, 'total', total_count, 'rows', page_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_questions_by_ids(question_ids_param uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  requested_count integer;
  selected_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  requested_count := COALESCE(cardinality(question_ids_param), 0);
  IF requested_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Between 1 and 500 question IDs are required';
  END IF;
  IF array_position(question_ids_param, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT id) FROM unnest(question_ids_param) AS id) <> requested_count THEN
    RAISE EXCEPTION 'Question IDs must be unique and non-null';
  END IF;

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', question.id,
    'subject', question.subject,
    'type', question.type,
    'question_number', question.question_number,
    'question_text', question.question_text,
    'options', question.options,
    'correct_answer', question.correct_answer,
    'question_image_url', question.question_image_url,
    'option_image_urls', question.option_image_urls,
    'has_image_or_diagram', question.has_image_or_diagram,
    'details', question.details,
    'created_at', question.created_at
  ) ORDER BY requested.ordinality), '[]'::jsonb)
  INTO selected_rows
  FROM unnest(question_ids_param) WITH ORDINALITY AS requested(id, ordinality)
  JOIN numbered question ON question.id = requested.id;

  RETURN jsonb_build_object('requested_count', requested_count, 'rows', selected_rows);
END;
$function$;

-- Paragraph text lives on every question of its set; this rewrites all of them
-- in one statement. SECURITY INVOKER: the administrator RLS policy applies.
CREATE OR REPLACE FUNCTION public.admin_update_passage(
  passage_key_param pg_catalog.uuid,
  passage_text_param pg_catalog.text
)
RETURNS pg_catalog.int4
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  cleaned pg_catalog.text := pg_catalog.btrim(COALESCE(passage_text_param, ''));
  updated_count pg_catalog.int4;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF passage_key_param IS NULL THEN
    RAISE EXCEPTION 'Paragraph key is required';
  END IF;
  IF pg_catalog.length(cleaned) NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Paragraph text must contain between 1 and 10000 characters';
  END IF;

  UPDATE public.question_bank AS q
  SET details = pg_catalog.jsonb_set(q.details, '{passage,text}', pg_catalog.to_jsonb(cleaned))
  WHERE q.details -> 'passage' ->> 'key' OPERATOR(pg_catalog.=) passage_key_param::pg_catalog.text;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_passage(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_passage(pg_catalog.uuid, pg_catalog.text) TO authenticated;

COMMIT;
