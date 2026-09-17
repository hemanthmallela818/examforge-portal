-- Stage 19D: globally ranked, paginated administrator result views.

CREATE INDEX IF NOT EXISTS student_results_exam_score_order_idx
  ON public.student_results (exam_id, total_score DESC, student_id, id);

CREATE OR REPLACE FUNCTION public.get_admin_exam_results_page(
  exam_id_param uuid,
  page_number_param integer,
  page_size_param integer,
  search_param text DEFAULT NULL,
  expected_result_count_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  exam_subjects jsonb;
  overall_count integer;
  filtered_count integer;
  page_rows jsonb;
  analytics_payload jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF exam_id_param IS NULL THEN RAISE EXCEPTION 'Exam ID is required'; END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 500';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Result search must not exceed 100 characters';
  END IF;
  IF expected_result_count_param IS NOT NULL AND expected_result_count_param NOT BETWEEN 0 AND 20000 THEN
    RAISE EXCEPTION 'Expected result count must be between 0 and 20000';
  END IF;

  SELECT exam.questions_data->'subjects' INTO exam_subjects
  FROM public.cbt_exams exam WHERE exam.id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam was not found'; END IF;
  IF jsonb_typeof(exam_subjects) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Exam subjects are invalid';
  END IF;

  SELECT count(*)::integer INTO overall_count
  FROM public.student_results result WHERE result.exam_id = exam_id_param::text;
  IF expected_result_count_param IS NOT NULL AND overall_count IS DISTINCT FROM expected_result_count_param THEN
    RAISE EXCEPTION 'Result set changed: expected %, found %. Restart the export.', expected_result_count_param, overall_count;
  END IF;

  WITH base AS (
    SELECT result.*,
      rank() OVER (ORDER BY result.total_score DESC)::integer AS total_rank
    FROM public.student_results result
    WHERE result.exam_id = exam_id_param::text
  )
  SELECT count(*)::integer INTO filtered_count
  FROM base result
  WHERE normalized_search IS NULL
    OR position(lower(normalized_search) in lower(result.student_id)) > 0
    OR position(lower(normalized_search) in lower(COALESCE(result.student_name, ''))) > 0;

  WITH subjects AS (
    SELECT subject.value AS subject
    FROM jsonb_array_elements_text(exam_subjects) WITH ORDINALITY AS subject(value, position)
  ), base AS (
    SELECT result.*,
      rank() OVER (ORDER BY result.total_score DESC)::integer AS total_rank
    FROM public.student_results result
    WHERE result.exam_id = exam_id_param::text
  ), subject_expanded AS (
    SELECT result.id, subject.subject,
      COALESCE(NULLIF(result.subject_scores->>subject.subject, ''), '0')::numeric AS subject_score
    FROM base result CROSS JOIN subjects subject
  ), subject_ranked AS (
    SELECT expanded.*,
      rank() OVER (PARTITION BY expanded.subject ORDER BY expanded.subject_score DESC)::integer AS subject_rank
    FROM subject_expanded expanded
  ), subject_maps AS (
    SELECT ranked.id,
      jsonb_object_agg(ranked.subject, to_jsonb(ranked.subject_rank)) AS subject_ranks
    FROM subject_ranked ranked GROUP BY ranked.id
  ), filtered AS (
    SELECT result.*, COALESCE(maps.subject_ranks, '{}'::jsonb) AS subject_ranks
    FROM base result LEFT JOIN subject_maps maps ON maps.id = result.id
    WHERE normalized_search IS NULL
      OR position(lower(normalized_search) in lower(result.student_id)) > 0
      OR position(lower(normalized_search) in lower(COALESCE(result.student_name, ''))) > 0
  )
  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.total_score DESC, page_row.student_id, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT result.total_score, result.student_id, result.id,
      jsonb_build_object(
        'id', result.id,
        'exam_id', result.exam_id,
        'student_id', result.student_id,
        'student_name', result.student_name,
        'total_score', result.total_score,
        'max_score', result.max_score,
        'correct', result.correct,
        'incorrect', result.incorrect,
        'unattempted', result.unattempted,
        'subject_scores', result.subject_scores,
        'subject_ranks', result.subject_ranks,
        'total_rank', result.total_rank,
        'submitted_at', result.submitted_at
      ) AS payload
    FROM filtered result
    ORDER BY result.total_score DESC, result.student_id, result.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  WITH subjects AS (
    SELECT subject.value AS subject, subject.position
    FROM jsonb_array_elements_text(exam_subjects) WITH ORDINALITY AS subject(value, position)
  ), results AS (
    SELECT result.* FROM public.student_results result WHERE result.exam_id = exam_id_param::text
  ), subject_averages AS (
    SELECT subject.subject, subject.position,
      COALESCE(avg(COALESCE(NULLIF(result.subject_scores->>subject.subject, ''), '0')::numeric), 0) AS score
    FROM subjects subject LEFT JOIN results result ON true
    GROUP BY subject.subject, subject.position
  )
  SELECT CASE WHEN overall_count = 0 THEN NULL ELSE jsonb_build_object(
    'average_score', (SELECT avg(result.total_score) FROM results result),
    'highest_score', (SELECT max(result.total_score) FROM results result),
    'lowest_score', (SELECT min(result.total_score) FROM results result),
    'excluded_from_distribution', (SELECT count(*) FROM results result WHERE result.max_score <= 0),
    'distribution', jsonb_build_array(
      jsonb_build_object('name', '0-20%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 <= 20)),
      jsonb_build_object('name', '21-40%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 20 AND result.total_score / result.max_score * 100 <= 40)),
      jsonb_build_object('name', '41-60%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 40 AND result.total_score / result.max_score * 100 <= 60)),
      jsonb_build_object('name', '61-80%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 60 AND result.total_score / result.max_score * 100 <= 80)),
      jsonb_build_object('name', '81-100%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 80))
    ),
    'subject_averages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', average.subject, 'score', average.score) ORDER BY average.position), '[]'::jsonb) FROM subject_averages average)
  ) END INTO analytics_payload;

  RETURN jsonb_build_object(
    'page', page_number_param,
    'page_size', page_size_param,
    'total', filtered_count,
    'result_count', overall_count,
    'subjects', exam_subjects,
    'analytics', analytics_payload,
    'rows', page_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_exam_results_page(uuid, integer, integer, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_exam_results_page(uuid, integer, integer, text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_admin_exam_results_export_page(
  exam_id_param uuid,
  after_student_id_param text,
  page_size_param integer,
  expected_result_count_param integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  exam_subjects jsonb;
  overall_count integer;
  page_rows jsonb;
  has_more boolean;
  next_cursor text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF exam_id_param IS NULL THEN RAISE EXCEPTION 'Exam ID is required'; END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Export page size must be between 1 and 500';
  END IF;
  IF expected_result_count_param IS NULL OR expected_result_count_param NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'Expected result count must be between 1 and 20000';
  END IF;

  SELECT exam.questions_data->'subjects' INTO exam_subjects
  FROM public.cbt_exams exam WHERE exam.id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam was not found'; END IF;
  IF jsonb_typeof(exam_subjects) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Exam subjects are invalid'; END IF;

  SELECT count(*)::integer INTO overall_count
  FROM public.student_results result WHERE result.exam_id = exam_id_param::text;
  IF overall_count IS DISTINCT FROM expected_result_count_param THEN
    RAISE EXCEPTION 'Result set changed: expected %, found %. Restart the export.', expected_result_count_param, overall_count;
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.payload ORDER BY candidate.student_id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT result.student_id,
      jsonb_build_object(
        'id', result.id,
        'exam_id', result.exam_id,
        'student_id', result.student_id,
        'student_name', result.student_name,
        'total_score', result.total_score,
        'max_score', result.max_score,
        'correct', result.correct,
        'incorrect', result.incorrect,
        'unattempted', result.unattempted,
        'subject_scores', result.subject_scores,
        'submitted_at', result.submitted_at
      ) AS payload
    FROM public.student_results result
    WHERE result.exam_id = exam_id_param::text
      AND (after_student_id_param IS NULL OR result.student_id > after_student_id_param)
    ORDER BY result.student_id
    LIMIT page_size_param + 1
  ) AS candidate;

  has_more := jsonb_array_length(page_rows) > page_size_param;
  IF has_more THEN page_rows := page_rows - page_size_param; END IF;
  next_cursor := CASE WHEN jsonb_array_length(page_rows) = 0 THEN NULL ELSE page_rows->-1->>'student_id' END;

  RETURN jsonb_build_object(
    'result_count', overall_count,
    'subjects', exam_subjects,
    'rows', page_rows,
    'has_more', has_more,
    'next_student_id', next_cursor
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_exam_results_export_page(uuid, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_exam_results_export_page(uuid, text, integer, integer) TO authenticated;
