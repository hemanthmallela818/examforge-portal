-- ============================================================================
-- Read-Only Failure-Safe Data-Quality Diagnostic Script for CBT Application
-- Strictly non-destructive: only contains read-only SELECT statements.
-- Does not modify, insert, delete, or alter any table or constraint.
-- Fully guarded: guarantees zero runtime exceptions on scalar, null, array,
-- or object type mismatches in JSON structures.
-- ============================================================================

WITH
-- 1. Unvalidated constraints in public schema
diag_unvalidated_constraints AS (
  SELECT
    'UNVALIDATED_CONSTRAINT' AS issue_type,
    'HIGH' AS severity,
    con.conrelid::regclass::text AS entity_name,
    con.conname AS entity_id,
    'Constraint ' || con.conname || ' on ' || con.conrelid::regclass::text || ' is marked NOT VALID' AS issue_details
  FROM pg_constraint con
  JOIN pg_namespace nsp ON nsp.oid = con.connamespace
  WHERE nsp.nspname = 'public'
    AND con.convalidated = false
),

-- 2. Student identity format violations
diag_invalid_students AS (
  SELECT
    'INVALID_STUDENT_RECORD' AS issue_type,
    'HIGH' AS severity,
    'students' AS entity_name,
    s.id::text AS entity_id,
    'Student ' || COALESCE(s.student_id, 'NULL') || ' has invalid format (name length: ' || length(COALESCE(s.name, '')) || ')' AS issue_details
  FROM public.students s
  WHERE s.student_id IS NULL
     OR s.student_id !~ '^[A-Za-z0-9._-]{2,64}$'
     OR length(btrim(COALESCE(s.name, ''))) NOT BETWEEN 1 AND 120
     OR (s.class IS NOT NULL AND length(btrim(s.class)) NOT BETWEEN 1 AND 120)
     OR (s.section IS NOT NULL AND length(btrim(s.section)) NOT BETWEEN 1 AND 32)
),

-- 3. Class and section format violations or duplicates
diag_invalid_classes AS (
  SELECT
    'INVALID_CLASS_RECORD' AS issue_type,
    'HIGH' AS severity,
    'classes' AS entity_name,
    c.id::text AS entity_id,
    'Class ' || COALESCE(c.name, 'NULL') || ' has invalid sections (cardinality: ' || COALESCE(cardinality(c.sections), 0) || ')' AS issue_details
  FROM public.classes c
  WHERE length(btrim(COALESCE(c.name, ''))) NOT BETWEEN 1 AND 120
     OR c.sections IS NULL
     OR cardinality(c.sections) = 0
     OR array_position(c.sections, '') IS NOT NULL
     OR array_position(c.sections, NULL) IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM unnest(c.sections) s GROUP BY lower(btrim(s)) HAVING count(*) > 1
     )
),

-- 4. Question bank rows with format, option, or answer violations
diag_invalid_question_bank AS (
  SELECT
    'INVALID_QUESTION_BANK_ROW' AS issue_type,
    'HIGH' AS severity,
    'question_bank' AS entity_name,
    qb.id::text AS entity_id,
    'Question in ' || COALESCE(qb.subject, 'NULL') || ' (type: ' || COALESCE(qb.type, 'NULL') || ') fails format or answer rule' AS issue_details
  FROM public.question_bank qb
  WHERE qb.type NOT IN ('MCQ', 'NUMERICAL', 'NAT')
     OR qb.subject NOT IN ('Physics', 'Chemistry', 'Mathematics')
     OR (length(btrim(COALESCE(qb.question_text, ''))) = 0 AND length(btrim(COALESCE(qb.question_image_url, ''))) = 0)
     OR length(btrim(COALESCE(qb.question_text, ''))) > 10000
     OR length(COALESCE(qb.question_image_url, '')) > 2048
     OR (
       qb.type = 'MCQ' AND (
         jsonb_typeof(qb.options) <> 'array'
         OR jsonb_array_length(CASE WHEN jsonb_typeof(qb.options) = 'array' THEN qb.options ELSE '[]'::jsonb END) <> 4
         OR qb.correct_answer NOT IN ('0', '1', '2', '3')
         OR (qb.option_image_urls IS NOT NULL AND (
           jsonb_typeof(qb.option_image_urls) <> 'array'
           OR (CASE WHEN jsonb_typeof(qb.option_image_urls) = 'array' THEN jsonb_array_length(qb.option_image_urls) ELSE -1 END) <> 4
         ))
         OR EXISTS (
           SELECT 1 FROM generate_series(0, 3) idx
           WHERE length(btrim(COALESCE(qb.options->>idx, ''))) = 0
             AND length(btrim(COALESCE(qb.option_image_urls->>idx, ''))) = 0
         )
         OR (
           SELECT count(DISTINCT
             CASE
               WHEN length(btrim(COALESCE(opt.val, ''))) > 0 THEN 'text:' || lower(btrim(opt.val))
               ELSE 'empty:' || opt.ord::text
             END
           )
           FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(qb.options) = 'array' THEN qb.options ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS opt(val, ord)
         ) <> 4
       )
     )
     OR (
       qb.type IN ('NUMERICAL', 'NAT') AND (
         (jsonb_typeof(qb.options) = 'array' AND jsonb_array_length(qb.options) > 0)
         OR qb.correct_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
         OR length(COALESCE(qb.correct_answer, '')) > 100
         OR (qb.option_image_urls IS NOT NULL AND qb.option_image_urls NOT IN ('[]'::jsonb, '[null, null, null, null]'::jsonb))
       )
     )
),

diag_duplicate_question_bank AS (
  SELECT
    'DUPLICATE_QUESTION_BANK_PROMPT' AS issue_type,
    'HIGH' AS severity,
    'question_bank' AS entity_name,
    min(qb.id::text) AS entity_id,
    count(*)::text || ' questions have the same canonical prompt' AS issue_details
  FROM public.question_bank qb
  WHERE length(btrim(COALESCE(qb.question_text, ''))) > 0
  GROUP BY lower(regexp_replace(btrim(normalize(qb.question_text, NFKC)), '[[:space:]]+', ' ', 'g'))
  HAVING count(*) > 1
),

-- 5. Malformed or invalid root exams in cbt_exams_raw
diag_malformed_exams AS (
  SELECT
    'MALFORMED_EXAM' AS issue_type,
    'CRITICAL' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Exam "' || COALESCE(ex.title, 'NULL') || '" has invalid root structure or duration/marking configuration' AS issue_details
  FROM public.cbt_exams_raw ex
  WHERE length(btrim(COALESCE(ex.title, ''))) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(ex.questions_data) <> 'object'
     OR jsonb_typeof(ex.questions_data->'subjects') <> 'array'
     OR jsonb_array_length(CASE WHEN jsonb_typeof(ex.questions_data->'subjects') = 'array' THEN ex.questions_data->'subjects' ELSE '[]'::jsonb END) = 0
     OR jsonb_typeof(ex.questions_data->'questions') <> 'object'
     OR (ex.questions_data->>'duration') IS NULL
     OR (ex.questions_data->>'duration') !~ '^[0-9]+$'
     OR CASE WHEN (ex.questions_data->>'duration') ~ '^[0-9]+$' THEN (ex.questions_data->>'duration')::integer NOT BETWEEN 1 AND 600 ELSE true END
     OR (ex.questions_data->>'marksCorrect') IS NULL
     OR (ex.questions_data->>'marksCorrect') !~ '^[+]?[0-9]+([.][0-9]+)?$'
     OR CASE WHEN (ex.questions_data->>'marksCorrect') ~ '^[+]?[0-9]+([.][0-9]+)?$' THEN (ex.questions_data->>'marksCorrect')::numeric NOT BETWEEN 0 AND 100 ELSE true END
     OR (ex.questions_data->>'marksIncorrect') IS NULL
     OR (ex.questions_data->>'marksIncorrect') !~ '^-?[0-9]+([.][0-9]+)?$'
     OR CASE WHEN (ex.questions_data->>'marksIncorrect') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (ex.questions_data->>'marksIncorrect')::numeric NOT BETWEEN -100 AND 0 ELSE true END
),

-- 6. Exam subject issues: blank subjects, duplicate subjects, and mapping mismatches
diag_subject_issues AS (
  -- Blank subject
  SELECT
    'EXAM_BLANK_SUBJECT' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Exam "' || ex.title || '" has blank or empty subject at index ' || sub.ord::text AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(ex.questions_data->'subjects') = 'array' THEN ex.questions_data->'subjects' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS sub(val, ord)
  WHERE length(btrim(COALESCE(sub.val, ''))) = 0

  UNION ALL

  -- Duplicate subjects within the same exam
  SELECT
    'EXAM_DUPLICATE_SUBJECT' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Exam "' || ex.title || '" contains duplicate subject "' || sub.sub_name || '"' AS issue_details
  FROM (
    SELECT
      ex_inner.id,
      ex_inner.title,
      lower(btrim(sub_val.val)) AS sub_name
    FROM public.cbt_exams_raw ex_inner
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(ex_inner.questions_data->'subjects') = 'array' THEN ex_inner.questions_data->'subjects' ELSE '[]'::jsonb END
    ) AS sub_val(val)
    WHERE length(btrim(COALESCE(sub_val.val, ''))) > 0
    GROUP BY ex_inner.id, ex_inner.title, lower(btrim(sub_val.val))
    HAVING count(*) > 1
  ) sub
  JOIN public.cbt_exams_raw ex ON ex.id = sub.id

  UNION ALL

  -- Declared subject missing from questions object
  SELECT
    'EXAM_SUBJECT_MISMATCH' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Declared subject "' || sub.val || '" missing in questions object for exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(ex.questions_data->'subjects') = 'array' THEN ex.questions_data->'subjects' ELSE '[]'::jsonb END
  ) AS sub(val)
  WHERE jsonb_typeof(ex.questions_data->'questions') = 'object'
    AND NOT (ex.questions_data->'questions' ? sub.val)

  UNION ALL

  -- Questions object contains undeclared subject
  SELECT
    'EXAM_UNDECLARED_SUBJECT' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Questions object contains undeclared subject "' || q_sub.key || '" for exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(key, val)
  WHERE jsonb_typeof(ex.questions_data->'subjects') = 'array'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(ex.questions_data->'subjects') AS s(val)
      WHERE lower(btrim(s.val)) = lower(btrim(q_sub.key))
    )
),

-- 7. Exam question issues: duplicates across subjects, missing IDs, missing prompts
diag_exam_question_issues AS (
  -- Duplicate question IDs across entire paper (within or across subjects)
  SELECT
    'EXAM_DUPLICATE_QUESTION_ID' AS issue_type,
    'CRITICAL' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Question ID "' || (item.val->>'id') || '" is duplicated in exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE length(btrim(COALESCE(item.val->>'id', ''))) > 0
  GROUP BY ex.id, ex.title, (item.val->>'id')
  HAVING count(*) > 1

  UNION ALL

  -- Missing or empty question ID
  SELECT
    'EXAM_MISSING_QUESTION_ID' AS issue_type,
    'CRITICAL' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Question missing valid non-empty "id" in exam "' || ex.title || '" (subject: ' || q_sub.sub || ')' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE (item.val->>'id' IS NULL OR length(btrim(item.val->>'id')) = 0)

  UNION ALL

  -- Question missing both text prompt and question image
  SELECT
    'EXAM_QUESTION_MISSING_PROMPT' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Question "' || COALESCE(item.val->>'id', 'unidentified') || '" is missing both prompt text and question image in exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE length(btrim(COALESCE(item.val->>'text', item.val->>'question_text', ''))) = 0
    AND length(btrim(COALESCE(item.val->>'questionImageUrl', item.val->>'imageUrl', ''))) = 0

  UNION ALL

  SELECT
    'EXAM_REQUIRED_MEDIA_MISSING' AS issue_type,
    'CRITICAL' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Question "' || COALESCE(item.val->>'id', 'unidentified') || '" is marked as requiring an image or diagram but none is attached' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE lower(COALESCE(item.val->>'hasImageOrDiagram', 'false')) = 'true'
    AND length(btrim(COALESCE(item.val->>'questionImageUrl', item.val->>'imageUrl', ''))) = 0
),

-- 8. Question type and option validation (MCQ options count, missing text+image, duplicate options)
diag_question_type_and_options AS (
  -- Invalid question type
  SELECT
    'EXAM_INVALID_QUESTION_TYPE' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Question ' || COALESCE(item.val->>'id', 'unidentified') || ' has unsupported type "' || COALESCE(item.val->>'type', 'NULL') || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE COALESCE(upper(item.val->>'type'), '') NOT IN ('MCQ', 'NUMERICAL', 'NAT')

  UNION ALL

  -- MCQ question with options not equal to 4
  SELECT
    'EXAM_INVALID_MCQ_OPTIONS' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'MCQ question ' || COALESCE(item.val->>'id', 'unidentified') || ' does not have exactly 4 options in exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE upper(COALESCE(item.val->>'type', 'MCQ')) = 'MCQ'
    AND (
      jsonb_typeof(item.val->'options') <> 'array'
      OR jsonb_array_length(item.val->'options') <> 4
    )

  UNION ALL

  -- MCQ option missing both text and image
  SELECT
    'EXAM_MCQ_MISSING_OPTION' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'MCQ question ' || COALESCE(item.val->>'id', 'unidentified') || ' option ' || opt.ord::text || ' is missing both text and image in exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(item.val->'options') = 'array' THEN item.val->'options' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS opt(val, ord)
  WHERE upper(COALESCE(item.val->>'type', 'MCQ')) = 'MCQ'
    AND length(btrim(COALESCE(opt.val, ''))) = 0
    AND length(btrim(COALESCE(
      CASE WHEN jsonb_typeof(item.val->'optionImageUrls') = 'array' THEN item.val->'optionImageUrls'->>(opt.ord::int - 1)
           WHEN jsonb_typeof(item.val->'option_image_urls') = 'array' THEN item.val->'option_image_urls'->>(opt.ord::int - 1)
           ELSE NULL END, ''))) = 0

  UNION ALL

  -- MCQ question with duplicate options (considering text, image, or mixed)
  SELECT
    'EXAM_MCQ_DUPLICATE_OPTION' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'MCQ question ' || q_opt.qid || ' has duplicate options in exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  JOIN (
    SELECT
      ex_inner.id AS exam_id,
      item.val->>'id' AS qid
    FROM public.cbt_exams_raw ex_inner
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(ex_inner.questions_data->'questions') = 'object' THEN ex_inner.questions_data->'questions' ELSE '{}'::jsonb END
    ) AS q_sub(sub, list)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
    ) AS item(val)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(item.val->'options') = 'array' THEN item.val->'options' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS opt(val, ord)
    WHERE upper(COALESCE(item.val->>'type', 'MCQ')) = 'MCQ'
      AND jsonb_typeof(item.val->'options') = 'array'
      AND jsonb_array_length(item.val->'options') = 4
    GROUP BY ex_inner.id, item.val->>'id'
    HAVING count(DISTINCT
      CASE
        WHEN length(btrim(COALESCE(opt.val, ''))) > 0 AND length(btrim(COALESCE(
             CASE WHEN jsonb_typeof(item.val->'optionImageUrls') = 'array' THEN item.val->'optionImageUrls'->>(opt.ord::int - 1)
                  WHEN jsonb_typeof(item.val->'option_image_urls') = 'array' THEN item.val->'option_image_urls'->>(opt.ord::int - 1)
                  ELSE NULL END, ''))) > 0
          THEN 'mixed:' || lower(btrim(opt.val)) || '|img:' || btrim(COALESCE(
               CASE WHEN jsonb_typeof(item.val->'optionImageUrls') = 'array' THEN item.val->'optionImageUrls'->>(opt.ord::int - 1)
                    WHEN jsonb_typeof(item.val->'option_image_urls') = 'array' THEN item.val->'option_image_urls'->>(opt.ord::int - 1)
                    ELSE NULL END, ''))
        WHEN length(btrim(COALESCE(
             CASE WHEN jsonb_typeof(item.val->'optionImageUrls') = 'array' THEN item.val->'optionImageUrls'->>(opt.ord::int - 1)
                  WHEN jsonb_typeof(item.val->'option_image_urls') = 'array' THEN item.val->'option_image_urls'->>(opt.ord::int - 1)
                  ELSE NULL END, ''))) > 0
          THEN 'img:' || btrim(COALESCE(
               CASE WHEN jsonb_typeof(item.val->'optionImageUrls') = 'array' THEN item.val->'optionImageUrls'->>(opt.ord::int - 1)
                    WHEN jsonb_typeof(item.val->'option_image_urls') = 'array' THEN item.val->'option_image_urls'->>(opt.ord::int - 1)
                    ELSE NULL END, ''))
        WHEN length(btrim(COALESCE(opt.val, ''))) > 0
          THEN 'text:' || lower(btrim(opt.val))
        ELSE 'empty:' || opt.ord::text
      END
    ) <> 4
  ) q_opt ON q_opt.exam_id = ex.id

  UNION ALL

  -- Numerical question with options
  SELECT
    'EXAM_NUMERICAL_WITH_OPTIONS' AS issue_type,
    'HIGH' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Numerical question ' || COALESCE(item.val->>'id', 'unidentified') || ' has multiple-choice options in exam "' || ex.title || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE upper(COALESCE(item.val->>'type', '')) IN ('NUMERICAL', 'NAT')
    AND jsonb_typeof(item.val->'options') = 'array'
    AND jsonb_array_length(item.val->'options') > 0
),

-- 9. Private answer sync and metadata issues
diag_private_answers AS (
  -- Missing entire private answer row for an exam
  SELECT
    'MISSING_PRIVATE_ANSWERS_ROW' AS issue_type,
    'CRITICAL' AS severity,
    'cbt_exam_answers' AS entity_name,
    ex.id::text AS entity_id,
    'Exam "' || ex.title || '" has no corresponding row in cbt_exam_answers' AS issue_details
  FROM public.cbt_exams_raw ex
  LEFT JOIN public.cbt_exam_answers ans ON ans.exam_id = ex.id
  WHERE ans.exam_id IS NULL

  UNION ALL

  -- Question in exam has no answer key in cbt_exam_answers
  SELECT
    'MISSING_QUESTION_ANSWER_KEY' AS issue_type,
    'CRITICAL' AS severity,
    'cbt_exam_answers' AS entity_name,
    ex.id::text AS entity_id,
    'Question "' || (item.val->>'id') || '" in exam "' || ex.title || '" has no entry in cbt_exam_answers' AS issue_details
  FROM public.cbt_exams_raw ex
  JOIN public.cbt_exam_answers ans ON ans.exam_id = ex.id
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE (item.val->>'id') IS NOT NULL
    AND jsonb_typeof(ans.answers) = 'object'
    AND NOT (ans.answers ? (item.val->>'id'))

  UNION ALL

  -- Answer key in cbt_exam_answers not present in exam questions
  SELECT
    'EXTRANEOUS_ANSWER_KEY' AS issue_type,
    'MEDIUM' AS severity,
    'cbt_exam_answers' AS entity_name,
    ans.exam_id::text AS entity_id,
    'Private answer key contains question ID "' || ans_entry.key || '" not present in exam questions' AS issue_details
  FROM public.cbt_exam_answers ans
  JOIN public.cbt_exams_raw ex ON ex.id = ans.exam_id
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ans.answers) = 'object' THEN ans.answers ELSE '{}'::jsonb END
  ) AS ans_entry(key, val)
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_each(
      CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
    ) AS q_sub(sub, list)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
    ) AS item(val)
    WHERE item.val->>'id' = ans_entry.key
  )

  UNION ALL

  -- Private answer metadata or value invalid
  SELECT
    'PRIVATE_ANSWER_MALFORMED' AS issue_type,
    'HIGH' AS severity,
    'cbt_exam_answers' AS entity_name,
    ans.exam_id::text AS entity_id,
    'Private answer for question ID "' || ans_entry.key || '" is malformed or missing required metadata' AS issue_details
  FROM public.cbt_exam_answers ans
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ans.answers) = 'object' THEN ans.answers ELSE '{}'::jsonb END
  ) AS ans_entry(key, val)
  WHERE jsonb_typeof(ans_entry.val) <> 'object'
     OR (ans_entry.val->>'correct_answer') IS NULL
     OR (ans_entry.val->>'subject') IS NULL
     OR (ans_entry.val->>'type') IS NULL

  UNION ALL

  -- Private answer value out of bounds for its type
  SELECT
    'PRIVATE_ANSWER_INVALID_VALUE' AS issue_type,
    'HIGH' AS severity,
    'cbt_exam_answers' AS entity_name,
    ans.exam_id::text AS entity_id,
    'Private answer for question ID "' || ans_entry.key || '" has invalid value "' || COALESCE(ans_entry.val->>'correct_answer', 'NULL') || '" for type ' || COALESCE(ans_entry.val->>'type', 'NULL') AS issue_details
  FROM public.cbt_exam_answers ans
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ans.answers) = 'object' THEN ans.answers ELSE '{}'::jsonb END
  ) AS ans_entry(key, val)
  WHERE jsonb_typeof(ans_entry.val) = 'object'
    AND (
      (upper(COALESCE(ans_entry.val->>'type', '')) = 'MCQ' AND ans_entry.val->>'correct_answer' NOT IN ('0', '1', '2', '3'))
      OR
      (upper(COALESCE(ans_entry.val->>'type', '')) IN ('NUMERICAL', 'NAT') AND ans_entry.val->>'correct_answer' !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$')
    )

  UNION ALL

  -- Private answer subject mismatch with question definition
  SELECT
    'PRIVATE_ANSWER_SUBJECT_MISMATCH' AS issue_type,
    'HIGH' AS severity,
    'cbt_exam_answers' AS entity_name,
    ans.exam_id::text AS entity_id,
    'Private answer subject "' || (ans_entry.val->>'subject') || '" does not match exam subject "' || q_sub.sub || '" for question ' || ans_entry.key AS issue_details
  FROM public.cbt_exam_answers ans
  JOIN public.cbt_exams_raw ex ON ex.id = ans.exam_id
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ans.answers) = 'object' THEN ans.answers ELSE '{}'::jsonb END
  ) AS ans_entry(key, val)
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(ex.questions_data->'questions') = 'object' THEN ex.questions_data->'questions' ELSE '{}'::jsonb END
  ) AS q_sub(sub, list)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(q_sub.list) = 'array' THEN q_sub.list ELSE '[]'::jsonb END
  ) AS item(val)
  WHERE item.val->>'id' = ans_entry.key
    AND jsonb_typeof(ans_entry.val) = 'object'
    AND ans_entry.val ? 'subject'
    AND lower(btrim(ans_entry.val->>'subject')) <> lower(btrim(q_sub.sub))
),

-- 10. Orphaned results, sessions, or invalid UUID exam references
diag_orphaned_sessions_and_results AS (
  -- Invalid exam_id UUID format in student_results
  SELECT
    'INVALID_EXAM_ID_FORMAT' AS issue_type,
    'HIGH' AS severity,
    'student_results' AS entity_name,
    sr.id::text AS entity_id,
    'Student result contains malformed non-UUID exam_id "' || sr.exam_id || '"' AS issue_details
  FROM public.student_results sr
  WHERE sr.exam_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

  UNION ALL

  -- Orphaned student results
  SELECT
    'ORPHANED_STUDENT_RESULT' AS issue_type,
    'CRITICAL' AS severity,
    'student_results' AS entity_name,
    sr.id::text AS entity_id,
    'Student result references non-existent exam ID "' || sr.exam_id || '"' AS issue_details
  FROM public.student_results sr
  LEFT JOIN public.cbt_exams_raw ex ON ex.id::text = sr.exam_id
  WHERE ex.id IS NULL

  UNION ALL

  -- Invalid exam_id UUID format in active_sessions
  SELECT
    'INVALID_EXAM_ID_FORMAT' AS issue_type,
    'HIGH' AS severity,
    'active_sessions' AS entity_name,
    ses.id AS entity_id,
    'Active session contains malformed non-UUID exam_id "' || ses.exam_id || '"' AS issue_details
  FROM public.active_sessions ses
  WHERE ses.exam_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

  UNION ALL

  -- Orphaned active sessions
  SELECT
    'ORPHANED_ACTIVE_SESSION' AS issue_type,
    'HIGH' AS severity,
    'active_sessions' AS entity_name,
    ses.id AS entity_id,
    'Active session references non-existent exam ID "' || ses.exam_id || '"' AS issue_details
  FROM public.active_sessions ses
  LEFT JOIN public.cbt_exams_raw ex ON ex.id::text = ses.exam_id
  WHERE ex.id IS NULL
),

-- 11. Class and section assignment mismatches (students and exams)
diag_unassigned_class_and_section_references AS (
  -- Student assigned to non-existent class
  SELECT
    'INVALID_STUDENT_CLASS_ASSIGNMENT' AS issue_type,
    'MEDIUM' AS severity,
    'students' AS entity_name,
    s.id::text AS entity_id,
    'Student assigned to non-existent class "' || s.class || '"' AS issue_details
  FROM public.students s
  LEFT JOIN public.classes c ON c.name = s.class
  WHERE s.class IS NOT NULL
    AND c.id IS NULL

  UNION ALL

  -- Student assigned to invalid section
  SELECT
    'INVALID_STUDENT_SECTION_ASSIGNMENT' AS issue_type,
    'MEDIUM' AS severity,
    'students' AS entity_name,
    s.id::text AS entity_id,
    'Student assigned to section "' || s.section || '" not in class "' || s.class || '"' AS issue_details
  FROM public.students s
  JOIN public.classes c ON c.name = s.class
  WHERE s.section IS NOT NULL
    AND NOT (c.sections @> ARRAY[s.section])

  UNION ALL

  -- Exam assigned to non-existent class
  SELECT
    'INVALID_EXAM_CLASS_ASSIGNMENT' AS issue_type,
    'MEDIUM' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Exam assigned to non-existent class "' || ex.class || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  LEFT JOIN public.classes c ON c.name = ex.class
  WHERE ex.class IS NOT NULL
    AND ex.class <> 'All'
    AND c.id IS NULL

  UNION ALL

  -- Exam assigned to invalid section for its class
  SELECT
    'INVALID_EXAM_SECTION_ASSIGNMENT' AS issue_type,
    'MEDIUM' AS severity,
    'cbt_exams_raw' AS entity_name,
    ex.id::text AS entity_id,
    'Exam assigned to section "' || ex.section || '" which does not belong to class "' || ex.class || '"' AS issue_details
  FROM public.cbt_exams_raw ex
  JOIN public.classes c ON c.name = ex.class
  WHERE ex.class IS NOT NULL
    AND ex.class <> 'All'
    AND ex.section IS NOT NULL
    AND ex.section <> 'All'
    AND NOT (c.sections @> ARRAY[ex.section])
)

-- Combined Diagnostic Report
SELECT
  issue_type,
  severity,
  entity_name,
  entity_id,
  issue_details
FROM (
  SELECT * FROM diag_unvalidated_constraints
  UNION ALL SELECT * FROM diag_invalid_students
  UNION ALL SELECT * FROM diag_invalid_classes
  UNION ALL SELECT * FROM diag_invalid_question_bank
  UNION ALL SELECT * FROM diag_duplicate_question_bank
  UNION ALL SELECT * FROM diag_malformed_exams
  UNION ALL SELECT * FROM diag_subject_issues
  UNION ALL SELECT * FROM diag_exam_question_issues
  UNION ALL SELECT * FROM diag_question_type_and_options
  UNION ALL SELECT * FROM diag_private_answers
  UNION ALL SELECT * FROM diag_orphaned_sessions_and_results
  UNION ALL SELECT * FROM diag_unassigned_class_and_section_references
) all_issues
ORDER BY
  CASE severity
    WHEN 'CRITICAL' THEN 1
    WHEN 'HIGH' THEN 2
    WHEN 'MEDIUM' THEN 3
    ELSE 4
  END,
  issue_type,
  entity_name;
