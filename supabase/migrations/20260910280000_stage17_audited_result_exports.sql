-- Stage 17: AAL2-only, count-verified audit boundary for result exports.
-- The export stays client-generated, but it cannot begin without an immutable
-- server audit event tied to the authoritative exam and result count.

CREATE OR REPLACE FUNCTION public.record_result_export(
  exam_id_param uuid,
  export_format_param text,
  expected_result_count_param integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  normalized_format text := upper(btrim(COALESCE(export_format_param, '')));
  authoritative_count integer;
  exam_title text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF exam_id_param IS NULL THEN
    RAISE EXCEPTION 'Exam ID is required';
  END IF;
  IF normalized_format NOT IN ('CSV', 'PDF') THEN
    RAISE EXCEPTION 'Export format must be CSV or PDF';
  END IF;
  IF expected_result_count_param IS NULL OR expected_result_count_param < 1 OR expected_result_count_param > 20000 THEN
    RAISE EXCEPTION 'Expected result count must be between 1 and 20000';
  END IF;

  SELECT title INTO exam_title
  FROM public.cbt_exams_raw
  WHERE id = exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam was not found';
  END IF;

  SELECT count(*)::integer INTO authoritative_count
  FROM public.student_results
  WHERE exam_id = exam_id_param::text;

  IF authoritative_count IS DISTINCT FROM expected_result_count_param THEN
    RAISE EXCEPTION 'Result set changed: expected %, found %. Refresh results before exporting.',
      expected_result_count_param, authoritative_count;
  END IF;

  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'RESULT_EXPORT_REQUESTED',
    'cbt_exam',
    exam_id_param::text,
    jsonb_build_object(
      'format', normalized_format,
      'result_count', authoritative_count,
      'exam_title', exam_title
    )
  );

  RETURN jsonb_build_object(
    'authorized', true,
    'format', normalized_format,
    'result_count', authoritative_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_result_export(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_result_export(uuid, text, integer) TO authenticated;
