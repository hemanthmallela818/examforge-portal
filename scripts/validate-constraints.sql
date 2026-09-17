-- ============================================================================
-- Safe Constraint Validation Procedure for CBT Application
-- Strictly safe: Never silently repairs or deletes rows.
-- Validation runs ONLY after checking all preconditions.
-- If any violation exists, it raises an exception and aborts the transaction.
-- IMPORTANT: DO NOT EXECUTE ON LINKED PRODUCTION DATABASE UNTIL
-- diagnostic-data-quality.sql REPORTS ZERO RELEVANT VIOLATIONS.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_invalid_profiles integer := 0;
  v_invalid_exam_status integer := 0;
  v_invalid_classes integer := 0;
  v_invalid_question_bank integer := 0;
  v_invalid_exam_data integer := 0;
BEGIN
  -- 1. Precondition Check: profiles_role_valid
  SELECT count(*) INTO v_invalid_profiles
  FROM public.profiles
  WHERE role NOT IN ('student', 'admin');

  IF v_invalid_profiles > 0 THEN
    RAISE EXCEPTION 'Constraint validation aborted: % invalid profiles rows found (role must be student or admin).', v_invalid_profiles;
  END IF;

  -- 2. Precondition Check: cbt_exams_status_valid (must match migration 20260910010000)
  SELECT count(*) INTO v_invalid_exam_status
  FROM public.cbt_exams_raw
  WHERE status NOT IN ('PENDING', 'ACTIVE', 'ENDED');

  IF v_invalid_exam_status > 0 THEN
    RAISE EXCEPTION 'Constraint validation aborted: % invalid cbt_exams_raw status rows found.', v_invalid_exam_status;
  END IF;

  -- 3. Precondition Check: classes_data_valid
  SELECT count(*) INTO v_invalid_classes
  FROM public.classes
  WHERE length(btrim(COALESCE(name, ''))) NOT BETWEEN 1 AND 120
     OR sections IS NULL
     OR cardinality(sections) = 0
     OR array_position(sections, '') IS NOT NULL
     OR array_position(sections, NULL) IS NOT NULL;

  IF v_invalid_classes > 0 THEN
    RAISE EXCEPTION 'Constraint validation aborted: % invalid classes rows found.', v_invalid_classes;
  END IF;

  -- 4. Precondition Check: question_bank_data_valid (type-safe guarded)
  SELECT count(*) INTO v_invalid_question_bank
  FROM public.question_bank
  WHERE type NOT IN ('MCQ', 'NUMERICAL', 'NAT')
     OR subject NOT IN ('Physics', 'Chemistry', 'Mathematics')
     OR (length(btrim(COALESCE(question_text, ''))) = 0 AND length(btrim(COALESCE(question_image_url, ''))) = 0)
     OR length(btrim(COALESCE(question_text, ''))) > 10000
     OR (
       type = 'MCQ' AND (
         jsonb_typeof(options) <> 'array'
         OR (CASE WHEN jsonb_typeof(options) = 'array' THEN jsonb_array_length(options) ELSE -1 END) <> 4
         OR correct_answer NOT IN ('0', '1', '2', '3')
         OR EXISTS (
           SELECT 1 FROM generate_series(0, 3) idx
           WHERE length(btrim(COALESCE(options->>idx, ''))) = 0
             AND length(btrim(COALESCE(option_image_urls->>idx, ''))) = 0
         )
       )
     )
     OR (
       type IN ('NUMERICAL', 'NAT') AND (
         (jsonb_typeof(options) = 'array' AND (CASE WHEN jsonb_typeof(options) = 'array' THEN jsonb_array_length(options) ELSE 0 END) > 0)
         OR correct_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
         OR length(COALESCE(correct_answer, '')) > 100
       )
     );

  IF v_invalid_question_bank > 0 THEN
    RAISE EXCEPTION 'Constraint validation aborted: % invalid question_bank rows found.', v_invalid_question_bank;
  END IF;

  -- 5. Precondition Check: cbt_exams_data_valid (type-safe guarded against bad JSON and casts)
  SELECT count(*) INTO v_invalid_exam_data
  FROM public.cbt_exams_raw
  WHERE length(btrim(COALESCE(title, ''))) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(questions_data) <> 'object'
     OR jsonb_typeof(questions_data->'subjects') <> 'array'
     OR (CASE WHEN jsonb_typeof(questions_data->'subjects') = 'array' THEN jsonb_array_length(questions_data->'subjects') ELSE 0 END) = 0
     OR jsonb_typeof(questions_data->'questions') <> 'object'
     OR (questions_data->>'duration') IS NULL
     OR (questions_data->>'duration') !~ '^[0-9]+$'
     OR (CASE
          WHEN (questions_data->>'duration') ~ '^[0-9]+$'
          THEN (questions_data->>'duration')::integer NOT BETWEEN 1 AND 600
          ELSE true
        END)
     OR (questions_data->>'marksCorrect') IS NULL
     OR (questions_data->>'marksCorrect') !~ '^[+]?[0-9]+([.][0-9]+)?$'
     OR (CASE
          WHEN (questions_data->>'marksCorrect') ~ '^[+]?[0-9]+([.][0-9]+)?$'
          THEN (questions_data->>'marksCorrect')::numeric NOT BETWEEN 0 AND 100
          ELSE true
        END)
     OR (questions_data->>'marksIncorrect') IS NULL
     OR (questions_data->>'marksIncorrect') !~ '^-?[0-9]+([.][0-9]+)?$'
     OR (CASE
          WHEN (questions_data->>'marksIncorrect') ~ '^-?[0-9]+([.][0-9]+)?$'
          THEN (questions_data->>'marksIncorrect')::numeric NOT BETWEEN -100 AND 0
          ELSE true
        END);

  IF v_invalid_exam_data > 0 THEN
    RAISE EXCEPTION 'Constraint validation aborted: % invalid cbt_exams_raw data rows found.', v_invalid_exam_data;
  END IF;

  RAISE NOTICE 'Precondition checks passed cleanly (0 violations detected across all candidate constraints).';
END;
$$;

-- Safely validate all unvalidated constraints now that data integrity is proven
ALTER TABLE public.profiles VALIDATE CONSTRAINT profiles_role_valid;
ALTER TABLE public.cbt_exams_raw VALIDATE CONSTRAINT cbt_exams_status_valid;
ALTER TABLE public.classes VALIDATE CONSTRAINT classes_data_valid;
ALTER TABLE public.question_bank VALIDATE CONSTRAINT question_bank_data_valid;
ALTER TABLE public.cbt_exams_raw VALIDATE CONSTRAINT cbt_exams_data_valid;

COMMIT;
