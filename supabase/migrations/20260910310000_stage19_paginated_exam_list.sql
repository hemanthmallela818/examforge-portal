-- Stage 19C: bounded, answer-free administrator examination list.

CREATE INDEX IF NOT EXISTS cbt_exams_admin_list_idx
  ON public.cbt_exams_raw (status, created_at DESC, id);

CREATE OR REPLACE FUNCTION public.get_admin_exam_list_page(
  page_number_param integer,
  page_size_param integer,
  search_param text DEFAULT NULL,
  status_param text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  normalized_status text := NULLIF(upper(btrim(COALESCE(status_param, ''))), '');
  total_count integer;
  page_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 100';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Exam search must not exceed 100 characters';
  END IF;
  IF normalized_status IS NOT NULL AND normalized_status NOT IN ('PENDING', 'ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'Exam status filter is invalid';
  END IF;

  SELECT count(*)::integer INTO total_count
  FROM public.cbt_exams_raw exam
  WHERE (normalized_status IS NULL OR exam.status = normalized_status)
    AND (
      normalized_search IS NULL
      OR position(lower(normalized_search) in lower(exam.title)) > 0
      OR position(lower(normalized_search) in lower(COALESCE(exam.class, ''))) > 0
      OR position(lower(normalized_search) in lower(COALESCE(exam.section, ''))) > 0
    );

  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.created_at DESC, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT exam.created_at, exam.id,
      jsonb_build_object(
        'id', exam.id,
        'title', exam.title,
        'status', exam.status,
        'class', exam.class,
        'section', exam.section,
        'created_at', exam.created_at,
        'duration', exam.questions_data->>'duration',
        'total_questions', exam.questions_data->>'totalQuestions',
        'subjects', COALESCE(exam.questions_data->'subjects', '[]'::jsonb)
      ) AS payload
    FROM public.cbt_exams_raw exam
    WHERE (normalized_status IS NULL OR exam.status = normalized_status)
      AND (
        normalized_search IS NULL
        OR position(lower(normalized_search) in lower(exam.title)) > 0
        OR position(lower(normalized_search) in lower(COALESCE(exam.class, ''))) > 0
        OR position(lower(normalized_search) in lower(COALESCE(exam.section, ''))) > 0
      )
    ORDER BY exam.created_at DESC, exam.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object('page', page_number_param, 'page_size', page_size_param, 'total', total_count, 'rows', page_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_exam_list_page(integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_exam_list_page(integer, integer, text, text) TO authenticated;
