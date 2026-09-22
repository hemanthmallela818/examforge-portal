-- Forward-only repair for hosted projects whose historical Stage 19 migration
-- was applied before the export-page routine was added to that file.
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
    RAISE EXCEPTION 'Active administrator access is required';
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
