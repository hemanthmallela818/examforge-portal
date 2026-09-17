-- Stage 25: remove database-advisor-only PL/pgSQL warnings without changing
-- function behavior, signatures, ownership, grants, or security settings.
--
-- The definitions are sourced from the already-applied forward migration
-- history and each replacement is guarded. If an expected definition ever
-- differs, the migration fails instead of applying an ambiguous rewrite.

DO $advisor_cleanup$
DECLARE
  function_definition text;
  expected_fragment text;
  replacement_fragment text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.sanitize_exam_responses(jsonb,jsonb)'::pg_catalog.regprocedure
  ) INTO function_definition;
  expected_fragment := E'  option_index integer;\n  idx integer;\nBEGIN';
  replacement_fragment := E'  option_index integer;\nBEGIN';
  IF pg_catalog.strpos(function_definition, expected_fragment) = 0 THEN
    RAISE EXCEPTION 'Unexpected sanitize_exam_responses definition';
  END IF;
  EXECUTE pg_catalog.replace(function_definition, expected_fragment, replacement_fragment);

  SELECT pg_catalog.pg_get_functiondef(
    'public.preflight_validate_exam(uuid)'::pg_catalog.regprocedure
  ) INTO function_definition;
  expected_fragment := E'  answer_question_id text;\n  option_index integer;\n  total_questions integer := 0;';
  replacement_fragment := E'  answer_question_id text;\n  total_questions integer := 0;';
  IF pg_catalog.strpos(function_definition, expected_fragment) = 0 THEN
    RAISE EXCEPTION 'Unexpected preflight_validate_exam definition';
  END IF;
  EXECUTE pg_catalog.replace(function_definition, expected_fragment, replacement_fragment);

  SELECT pg_catalog.pg_get_functiondef(
    'public.start_exam_session_stage3_internal(uuid,jsonb,jsonb)'::pg_catalog.regprocedure
  ) INTO function_definition;
  expected_fragment := E'BEGIN\n  IF auth.uid() IS NULL THEN';
  replacement_fragment := E'BEGIN\n  -- These legacy parameters remain for PostgREST compatibility. The server-owned paper and initial response state intentionally replace their values.\n  PERFORM exam_data_param, responses_param;\n  IF auth.uid() IS NULL THEN';
  IF pg_catalog.strpos(function_definition, expected_fragment) = 0 THEN
    RAISE EXCEPTION 'Unexpected start_exam_session_stage3_internal definition';
  END IF;
  EXECUTE pg_catalog.replace(function_definition, expected_fragment, replacement_fragment);
END;
$advisor_cleanup$;
