-- Migration: 20260909080000_candidate_result_lookup.sql
-- Adds get_student_exam_result(text) RPC for candidate score re-inspection.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_student_exam_result(exam_id_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  result_row public.student_results%ROWTYPE;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found';
  END IF;

  SELECT * INTO result_row FROM public.student_results
  WHERE student_id = student_row.student_id AND exam_id = exam_id_param;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_student_exam_result(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_student_exam_result(text) TO authenticated;

COMMIT;
