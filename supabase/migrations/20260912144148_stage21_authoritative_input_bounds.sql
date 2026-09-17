-- Stage 21D: bound every remaining collection/payload exposed to authoritative
-- browser-facing work before doing expensive validation or storage scans.

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_exam_payload_bounds(
  questions_data_param pg_catalog.jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  questions_obj pg_catalog.jsonb;
  subject_entry pg_catalog.record;
  question_item pg_catalog.jsonb;
  total_questions pg_catalog.int4 := 0;
BEGIN
  IF questions_data_param IS NULL THEN
    RETURN;
  END IF;

  IF pg_catalog.octet_length(questions_data_param::pg_catalog.text)
    OPERATOR(pg_catalog.>) 8388608
  THEN
    RAISE EXCEPTION 'Exam payload must not exceed 8 MiB';
  END IF;

  questions_obj := questions_data_param -> 'questions';
  IF pg_catalog.jsonb_typeof(questions_obj) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.jsonb_object_keys(questions_obj)
  ) OPERATOR(pg_catalog.>) 10 THEN
    RAISE EXCEPTION 'Exam payload must not contain more than 10 subject groups';
  END IF;

  FOR subject_entry IN
    SELECT item.key, item.value
    FROM pg_catalog.jsonb_each(questions_obj) AS item
  LOOP
    IF pg_catalog.octet_length(subject_entry.key) OPERATOR(pg_catalog.>) 120 THEN
      RAISE EXCEPTION 'Exam subject name must not exceed 120 bytes';
    END IF;
    IF pg_catalog.jsonb_typeof(subject_entry.value) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    total_questions := total_questions
      OPERATOR(pg_catalog.+) pg_catalog.jsonb_array_length(subject_entry.value);
    IF total_questions OPERATOR(pg_catalog.>) 500 THEN
      RAISE EXCEPTION 'Exam payload must contain no more than 500 questions';
    END IF;

    FOR question_item IN
      SELECT item.value
      FROM pg_catalog.jsonb_array_elements(subject_entry.value) AS item(value)
    LOOP
      IF pg_catalog.octet_length(question_item::pg_catalog.text)
        OPERATOR(pg_catalog.>) 65536
      THEN
        RAISE EXCEPTION 'An individual exam question must not exceed 64 KiB';
      END IF;
    END LOOP;
  END LOOP;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.assert_exam_payload_bounds(jsonb)
  FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.validate_full_exam_paper(text, jsonb)
  RENAME TO validate_full_exam_paper_stage1_internal;
REVOKE EXECUTE ON FUNCTION public.validate_full_exam_paper_stage1_internal(text, jsonb)
  FROM PUBLIC, anon, authenticated;
ALTER FUNCTION public.validate_full_exam_paper_stage1_internal(text, jsonb)
  SET search_path = '';

CREATE FUNCTION public.validate_full_exam_paper(
  p_title pg_catalog.text,
  p_questions_data pg_catalog.jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_exam_payload_bounds(p_questions_data);
  PERFORM public.validate_full_exam_paper_stage1_internal(p_title, p_questions_data);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.validate_full_exam_paper(text, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_exam_asset_referenced(asset_name pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN asset_name IS NULL
      OR pg_catalog.length(pg_catalog.btrim(asset_name)) OPERATOR(pg_catalog.=) 0
      OR pg_catalog.octet_length(asset_name) OPERATOR(pg_catalog.>) 1024
    THEN false
    ELSE
      EXISTS (
        SELECT 1
        FROM public.cbt_exams_raw AS exam
        WHERE pg_catalog.jsonb_path_exists(
          exam.questions_data,
          '$.** ? (@ == $asset)',
          pg_catalog.jsonb_build_object('asset', asset_name)
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.question_bank AS question
        WHERE question.question_image_url OPERATOR(pg_catalog.=) asset_name
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements_text(
              CASE
                WHEN pg_catalog.jsonb_typeof(question.option_image_urls)
                  OPERATOR(pg_catalog.=) 'array'
                THEN question.option_image_urls
                ELSE '[]'::pg_catalog.jsonb
              END
            ) AS option_image(value)
            WHERE option_image.value OPERATOR(pg_catalog.=) asset_name
          )
      )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.get_unreferenced_exam_assets()
RETURNS TABLE (
  name pg_catalog.text,
  id pg_catalog.text,
  created_at pg_catalog.timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  RETURN QUERY
  SELECT o.name::pg_catalog.text,
    o.id::pg_catalog.text,
    o.created_at
  FROM storage.objects AS o
  WHERE o.bucket_id OPERATOR(pg_catalog.=) 'exam-assets'
    AND NOT public.is_exam_asset_referenced(o.name)
  ORDER BY o.created_at, o.name
  LIMIT 500;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_exam_asset_cleanup(
  asset_names pg_catalog.text[]
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  normalized_names pg_catalog.text[];
  asset_name pg_catalog.text;
  supplied_count pg_catalog.int4;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  supplied_count := COALESCE(pg_catalog.cardinality(asset_names), 0);
  IF supplied_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Cleanup audit requires between 1 and 100 asset paths';
  END IF;

  SELECT pg_catalog.array_agg(
    DISTINCT pg_catalog.btrim(supplied.value)
    ORDER BY pg_catalog.btrim(supplied.value)
  )
  INTO normalized_names
  FROM pg_catalog.unnest(asset_names) AS supplied(value)
  WHERE supplied.value IS NOT NULL
    AND pg_catalog.octet_length(pg_catalog.btrim(supplied.value)) BETWEEN 1 AND 1024;

  IF COALESCE(pg_catalog.cardinality(normalized_names), 0)
    OPERATOR(pg_catalog.<>) supplied_count
  THEN
    RAISE EXCEPTION 'Asset paths must be unique, non-empty, and no more than 1024 bytes';
  END IF;

  FOREACH asset_name IN ARRAY normalized_names LOOP
    IF public.is_exam_asset_referenced(asset_name) THEN
      RAISE EXCEPTION 'Asset "%" is now referenced and cannot be recorded as deleted', asset_name;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM storage.objects AS o
      WHERE o.bucket_id OPERATOR(pg_catalog.=) 'exam-assets'
        AND o.name OPERATOR(pg_catalog.=) asset_name
    ) THEN
      RAISE EXCEPTION 'Asset "%" still exists in storage and was not deleted', asset_name;
    END IF;
  END LOOP;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    target_type,
    target_id,
    metadata
  ) VALUES (
    auth.uid(),
    'CLEANUP_UNREFERENCED_ASSETS',
    'STORAGE',
    'exam-assets',
    pg_catalog.jsonb_build_object(
      'deleted_count', pg_catalog.cardinality(normalized_names),
      'deleted_paths', pg_catalog.to_jsonb(normalized_names)
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'deleted_count', pg_catalog.cardinality(normalized_names),
    'deleted_paths', pg_catalog.to_jsonb(normalized_names)
  );
END;
$function$;

COMMIT;
