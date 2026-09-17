-- Stage 21G: preserve the audited delete workflows established in Stage 5.

BEGIN;

REVOKE DELETE ON TABLE public.cbt_exams FROM authenticated;
REVOKE DELETE ON TABLE public.classes FROM authenticated;
REVOKE DELETE ON TABLE public.question_bank FROM authenticated;

-- This function must be executable by authenticated because a Storage RLS
-- policy references it, but only AAL2 administrators may learn reference state.
CREATE OR REPLACE FUNCTION public.is_exam_asset_referenced(asset_name pg_catalog.text)
RETURNS pg_catalog.bool
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN NOT public.is_admin_aal2() THEN false
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

COMMIT;
