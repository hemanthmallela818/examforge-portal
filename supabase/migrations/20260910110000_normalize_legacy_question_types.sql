-- ============================================================================
-- Migration 20260910110000: Guarded Normalization of Legacy Question Types
-- Safely normalizes legacy lowercase question types ('mcq', 'nat', 'numerical')
-- to their canonical uppercase equivalents ('MCQ', 'NAT', 'NUMERICAL').
-- Strictly guarded: aborts if any unexpected types, invalid options, or invalid
-- answers exist, or if row counts do not match expected eligible counts.
-- ============================================================================

DO $$
DECLARE
  v_invalid_types_count integer := 0;
  v_invalid_structure_count integer := 0;
  v_eligible_count integer := 0;
  v_updated_count integer := 0;
BEGIN
  -- 1. Precondition: Check for any unexpected types outside the supported enum domain
  SELECT count(*) INTO v_invalid_types_count
  FROM public.question_bank
  WHERE type NOT IN ('MCQ', 'NUMERICAL', 'NAT', 'mcq', 'numerical', 'nat');

  IF v_invalid_types_count > 0 THEN
    RAISE EXCEPTION 'Legacy normalization aborted: % question_bank rows have unknown types outside (MCQ, NUMERICAL, NAT, mcq, numerical, nat).',
      v_invalid_types_count;
  END IF;

  -- 2. Precondition: Validate options and answers for all rows to be normalized
  SELECT count(*) INTO v_invalid_structure_count
  FROM public.question_bank
  WHERE (
    type = 'mcq' AND (
      jsonb_typeof(options) <> 'array'
      OR (CASE WHEN jsonb_typeof(options) = 'array' THEN jsonb_array_length(options) ELSE -1 END) <> 4
      OR correct_answer NOT IN ('0', '1', '2', '3')
    )
  ) OR (
    type IN ('nat', 'numerical') AND (
      (jsonb_typeof(options) = 'array' AND (CASE WHEN jsonb_typeof(options) = 'array' THEN jsonb_array_length(options) ELSE 0 END) > 0)
      OR correct_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
    )
  );

  IF v_invalid_structure_count > 0 THEN
    RAISE EXCEPTION 'Legacy normalization aborted: % lowercase question_bank rows fail structural option or answer rules.',
      v_invalid_structure_count;
  END IF;

  -- 3. Determine eligible count
  SELECT count(*) INTO v_eligible_count
  FROM public.question_bank
  WHERE type IN ('mcq', 'nat', 'numerical');

  IF v_eligible_count > 0 THEN
    -- 4. Perform exact atomic normalization
    UPDATE public.question_bank
    SET type = upper(type)
    WHERE type IN ('mcq', 'nat', 'numerical');

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    IF v_updated_count <> v_eligible_count THEN
      RAISE EXCEPTION 'Legacy normalization aborted: updated row count (%) did not match eligible count (%).',
        v_updated_count, v_eligible_count;
    END IF;

    RAISE NOTICE 'Successfully normalized % legacy question_bank rows to canonical uppercase types.', v_updated_count;
  ELSE
    RAISE NOTICE 'No legacy lowercase question_bank rows required normalization.';
  END IF;

  -- 5. Postcondition: Ensure zero lowercase question types remain
  IF EXISTS (SELECT 1 FROM public.question_bank WHERE type IN ('mcq', 'nat', 'numerical')) THEN
    RAISE EXCEPTION 'Legacy normalization postcondition check failed: lowercase question types still present in question_bank.';
  END IF;
END;
$$;
