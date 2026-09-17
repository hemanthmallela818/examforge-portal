-- Stage 6A: strict, atomic and retry-safe question ingestion.

CREATE OR REPLACE FUNCTION public.canonical_question_text(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT lower(regexp_replace(btrim(normalize(value, NFKC)), '[[:space:]]+', ' ', 'g'))
$$;
REVOKE ALL ON FUNCTION public.canonical_question_text(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.canonical_question_text(text) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.question_bank
    WHERE public.canonical_question_text(question_text) <> ''
    GROUP BY md5(public.canonical_question_text(question_text))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Question import migration blocked: duplicate canonical question text already exists';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS question_bank_canonical_text_unique
  ON public.question_bank (md5(public.canonical_question_text(question_text)))
  WHERE public.canonical_question_text(question_text) <> '';

CREATE TABLE IF NOT EXISTS public.question_import_batches (
  batch_id uuid PRIMARY KEY,
  imported_by uuid NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 32),
  file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  question_count integer NOT NULL CHECK (question_count BETWEEN 1 AND 500),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.question_import_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.question_import_batches FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.question_import_batches TO authenticated;
CREATE POLICY question_import_batches_read_aal2 ON public.question_import_batches
  FOR SELECT TO authenticated USING (public.is_admin_aal2());

-- History is written only in the same transaction as the imported questions.
DROP POLICY IF EXISTS import_history_admin_aal2 ON public.import_history;
DROP POLICY IF EXISTS import_history_admin_read_aal2 ON public.import_history;
DROP POLICY IF EXISTS import_history_admin_insert_aal2 ON public.import_history;
REVOKE INSERT, UPDATE, DELETE ON public.import_history FROM PUBLIC, anon, authenticated;
CREATE POLICY import_history_admin_read_aal2 ON public.import_history
  FOR SELECT TO authenticated USING (public.is_admin_aal2());

CREATE OR REPLACE FUNCTION public.admin_import_questions(
  batch_id_param uuid,
  file_name_param text,
  questions_param jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor_id uuid := auth.uid();
  item jsonb;
  option_value jsonb;
  item_type text;
  item_subject text;
  item_text text;
  item_answer text;
  item_options jsonb;
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
    IF (item - ARRAY['subject','type','question_text','options','correct_answer','has_image_or_diagram','category','points','neg_points']::text[]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Question contains unsupported fields';
    END IF;
    item_type := item->>'type';
    item_subject := item->>'subject';
    item_text := btrim(COALESCE(item->>'question_text', ''));
    item_answer := btrim(COALESCE(item->>'correct_answer', ''));
    item_options := item->'options';

    IF item_subject NOT IN ('Physics', 'Chemistry', 'Mathematics') THEN RAISE EXCEPTION 'Invalid question subject'; END IF;
    IF item_type NOT IN ('MCQ', 'NUMERICAL') THEN RAISE EXCEPTION 'Invalid question type'; END IF;
    IF length(item_text) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Question text must contain between 1 and 10000 characters'; END IF;
    IF jsonb_typeof(item->'has_image_or_diagram') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Image indicator must be boolean'; END IF;
    IF COALESCE((item->>'points')::integer, 0) <> 4 OR COALESCE((item->>'neg_points')::integer, 0) <> -1 THEN
      RAISE EXCEPTION 'Imported JEE questions must use +4/-1 scoring';
    END IF;

    IF item_type = 'MCQ' THEN
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 4 OR item_answer !~ '^[0-3]$' THEN
        RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
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
         OR item_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
        RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.question_bank WHERE public.canonical_question_text(question_text) = public.canonical_question_text(item_text)) THEN
      RAISE EXCEPTION 'A matching question already exists in the Question Bank';
    END IF;

    INSERT INTO public.question_bank (
      subject, type, question_text, options, correct_answer, has_image_or_diagram, category, points, neg_points
    ) VALUES (
      item_subject, item_type, item_text, item_options, item_answer,
      (item->>'has_image_or_diagram')::boolean, COALESCE(NULLIF(btrim(item->>'category'), ''), 'Mains'), 4, -1
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
$$;
REVOKE ALL ON FUNCTION public.admin_import_questions(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_import_questions(uuid, text, jsonb) TO authenticated;
