-- Stage 19B: bounded question-bank browsing and verified cross-page selection.

CREATE INDEX IF NOT EXISTS question_bank_admin_browse_idx
  ON public.question_bank (subject, type, created_at, id);

CREATE OR REPLACE FUNCTION public.get_admin_question_bank_page(
  page_number_param integer,
  page_size_param integer,
  search_param text DEFAULT NULL,
  subject_param text DEFAULT NULL,
  type_param text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  IF normalized_type IS NOT NULL AND normalized_type NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
    RAISE EXCEPTION 'Question type filter is invalid';
  END IF;

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  )
  SELECT count(*)::integer INTO total_count
  FROM numbered question
  WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
    AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE 'MCQ' END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)
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
      CASE lower(question.subject)
        WHEN 'maths' THEN 1 WHEN 'mathematics' THEN 1
        WHEN 'physics' THEN 2 WHEN 'chemistry' THEN 3 ELSE 4
      END AS subject_sort
    FROM numbered question
    WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
      AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE 'MCQ' END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)
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
        'created_at', question.created_at
      ) AS payload
    FROM filtered question
    ORDER BY question.subject_sort, question.subject, question.question_number, question.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object('page', page_number_param, 'page_size', page_size_param, 'total', total_count, 'rows', page_rows);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_admin_questions_by_ids(question_ids_param uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    'created_at', question.created_at
  ) ORDER BY requested.ordinality), '[]'::jsonb)
  INTO selected_rows
  FROM unnest(question_ids_param) WITH ORDINALITY AS requested(id, ordinality)
  JOIN numbered question ON question.id = requested.id;

  RETURN jsonb_build_object('requested_count', requested_count, 'rows', selected_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_question_bank_page(integer, integer, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_admin_questions_by_ids(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_question_bank_page(integer, integer, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_questions_by_ids(uuid[]) TO authenticated;
