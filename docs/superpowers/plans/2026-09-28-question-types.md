# More Question Types Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the multiple-correct (with partial marks), integer, matrix-match, assertion–reason, and paragraph-set formats end to end: bank, import, exam building, taking the exam, grading, and review.

**Architecture:**
- One forward-only migration adds shared SQL helpers for answer grammar, question details, marking resolution, and scoring. It then redefines the existing validators, grader, bank RPCs, and review RPC to call those helpers.
- On the client, one pure registry module (`src/questionTypes.js`) replaces every hard-coded `MCQ`/`NUMERICAL` branch.
- Candidate answers stay strings, so autosave, offline recovery, and submission plumbing are unchanged.

**Tech Stack:** React 19 + Vite, Supabase (PostgreSQL 17 plpgsql), PGlite database tests, node:test, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-28-question-types-design.md`

## Global Constraints

- **Type codes:** `MCQ`, `MULTIPLE_CORRECT`, `INTEGER`, `NUMERICAL`, `NAT` (legacy alias of `NUMERICAL`), `MATRIX_MATCH`, `ASSERTION_REASON`.
- **Multiple-correct answer:** the canonical string `^[0-3](,[0-3]){0,3}$` with strictly increasing indices, for example `"0,2"`. Never an array.
- **Integer answer:** `^[+-]?[0-9]+$`. At most 100 characters from an author and 64 from a candidate.
- **Option-bearing types** (`MCQ`, `MULTIPLE_CORRECT`, `MATRIX_MATCH`, `ASSERTION_REASON`) have exactly 4 unique options, each with text or an image, each at most 5000 characters.
- **Value types** (`INTEGER`, `NUMERICAL`, `NAT`) have `options = []`.
- **`details` jsonb:**
  - allowed keys are only `matchLists` and `passage`, and the object is at most 32 KiB
  - `matchLists` is `{left: 2–6 strings, right: 2–8 strings}`, each string 1–2000 characters; it is required for `MATRIX_MATCH` and forbidden for every other type
  - `passage` is `{key: uuid, text: 1–10000 characters}`
- **Marking:** each type's entry is `{correct in (0,100], incorrect in [−100,0], at most 2 decimal places, partial boolean (MULTIPLE_CORRECT only)}`. Every field is optional. The fallbacks are `marksCorrect`, `marksIncorrect`, and `partial = true`.
- **Partial marks** are `round(full × |S| / 4, 2)` when *S* ⊂ *C* and partial marking is on.
- **Messages for the existing MCQ and numerical errors stay byte-identical,** because current tests match them.
- **Every new SQL function:**
  - pins `search_path`
  - is `REVOKE`d from `PUBLIC, anon`
  - is granted only to the roles that call it
  - The migration-replay invariant test enforces "anon can execute only `get_public_branding()`".
- **New paths are `SET search_path = ''`,** schema-qualified with `public.`; built-ins resolve through `pg_catalog`.

## Review Focus

1. **Stale or crafted candidate payloads** for a multiple-correct question (`"2,0"`, `"0,0"`, `"0,,2"`, `"4"`, a JSON array) are rejected by both autosave and submit, never graded. Test in Task 3.
2. **Existing exams** (only MCQ/NUMERICAL, no `marking`) grade to exactly the same totals as before. Task 3 keeps the existing `exam-submission` expectations and adds only `partial: 0`.
3. **Clearing every checkbox** yields `selectedOption: null` (not `""`), so the status becomes NOT_ANSWERED and offline merge treats it as unanswered. Test in Task 6.
4. **Admin bank lists and filters** must show new types as themselves. Before this change `normalizeType` and the bank RPC silently turned unknown types into MCQ. Test in Tasks 1 and 5.
5. **The block shuffle never drops, duplicates, or splits a passage's questions,** including sets with only one question in the exam. Test in Task 2.

---

### Task 1: SQL foundation, bank storage, and bank RPCs

**Files:**
- Create: `supabase/migrations/20260928100000_question_types.sql`. Every SQL task appends to this one file, in task order.
- Create: `tests/db/question-types.test.mjs`
- Modify: `tests/db/harness.mjs`. Add a `createQuestion()` seed helper if one does not exist; direct `INSERT` via `asAdmin()` works otherwise.

**Interfaces (produces):**
- `public.question_type_is_option_based(t text) → boolean` (IMMUTABLE)
- `public.question_type_is_supported(t text) → boolean` (IMMUTABLE)
- `public.is_valid_correct_answer(t text, answer text) → boolean` (IMMUTABLE). Existing rules for MCQ and NUMERICAL/NAT; new rules for the new types.
- `public.question_details_error(t text, details jsonb) → text` (IMMUTABLE). Returns NULL when valid, otherwise a message.
- `public.question_identity_key(question_text text, details jsonb) → text` (IMMUTABLE STRICT on text). Returns `canonical_question_text(question_text) || '|' || COALESCE(details::text, '')`.
- New column `question_bank.details jsonb NULL`.
- `public.admin_update_passage(passage_key_param uuid, passage_text_param text) → integer` (rows updated; AAL2 admin only).
- The bank RPC rows gain `details`, and the type filter accepts every supported code.

Steps:

- [ ] **Write the failing database tests** in `tests/db/question-types.test.mjs`, using the `createTestDb()` harness the same way `tests/db/subjects-patterns.test.mjs` does. Cases:
  - Admin inserts succeed for:
    - a `MULTIPLE_CORRECT` question (4 options, `"0,2"`)
    - an `INTEGER` question (`"-12"`, no options)
    - a `MATRIX_MATCH` question with `details.matchLists`
    - an `ASSERTION_REASON` question
    - two questions sharing a `details.passage.key`
  - Rejections:
    - `MULTIPLE_CORRECT` with `"2,0"`, `"0,0"`, or `""`
    - `INTEGER` with `"2.5"`
    - `MATRIX_MATCH` without `matchLists`
    - `MCQ` with `matchLists`
    - `details` containing an unknown key
    - a passage key that is not a UUID
  - Duplicates:
    - two matrix-match questions with the same stem but different lists are both accepted
    - the same stem with identical lists is rejected by the unique index
    - two plain MCQs with the same text are still rejected
  - Bank RPCs:
    - `get_admin_question_bank_page(0, 50, NULL, NULL, 'MULTIPLE_CORRECT')` returns only that type, and its rows carry `details`
    - the `'NAT'` filter still matches NUMERICAL and NAT rows
  - `admin_update_passage`:
    - updates every question with the key and returns the count
    - raises for a student
    - raises for an empty text
  - `admin_import_questions` accepts a `MULTIPLE_CORRECT` row with `details` absent, and a row with `details.passage`
- [ ] **Run `npm run -s test:db -- tests/db/question-types.test.mjs`** (or `node --test tests/db/question-types.test.mjs`). Expected: FAIL. The column or functions do not exist.
- [ ] **Write the migration's first section:**

```sql
-- More question types: multiple correct (partial marks), integer, matrix match,
-- assertion-reason, and paragraph sets. See
-- docs/superpowers/specs/2026-09-28-question-types-design.md.
BEGIN;

CREATE OR REPLACE FUNCTION public.question_type_is_option_based(question_type pg_catalog.text)
RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
  SELECT pg_catalog.upper(COALESCE(question_type, 'MCQ')) IN ('MCQ', 'MULTIPLE_CORRECT', 'MATRIX_MATCH', 'ASSERTION_REASON')
$function$;

CREATE OR REPLACE FUNCTION public.question_type_is_supported(question_type pg_catalog.text)
RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
  SELECT pg_catalog.upper(COALESCE(question_type, 'MCQ')) IN
    ('MCQ', 'MULTIPLE_CORRECT', 'MATRIX_MATCH', 'ASSERTION_REASON', 'INTEGER', 'NUMERICAL', 'NAT')
$function$;

-- True when a multiple-correct value is canonical: 1-4 distinct indices below
-- option_count, strictly increasing, comma separated.
CREATE OR REPLACE FUNCTION public.is_canonical_option_set(value pg_catalog.text, option_count pg_catalog.int4)
RETURNS pg_catalog.bool LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
DECLARE
  part pg_catalog.text;
  previous pg_catalog.int4 := -1;
BEGIN
  IF value IS NULL OR value !~ '^[0-9](,[0-9]){0,9}$' THEN RETURN false; END IF;
  FOREACH part IN ARRAY pg_catalog.string_to_array(value, ',') LOOP
    IF part::pg_catalog.int4 <= previous OR part::pg_catalog.int4 >= option_count THEN RETURN false; END IF;
    previous := part::pg_catalog.int4;
  END LOOP;
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_valid_correct_answer(question_type pg_catalog.text, answer pg_catalog.text)
RETURNS pg_catalog.bool LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
  SELECT CASE pg_catalog.upper(COALESCE(question_type, 'MCQ'))
    WHEN 'MULTIPLE_CORRECT' THEN public.is_canonical_option_set(answer, 4)
    WHEN 'INTEGER' THEN COALESCE(answer ~ '^[+-]?[0-9]+$' AND pg_catalog.length(answer) <= 100, false)
    WHEN 'NUMERICAL' THEN COALESCE(answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$', false)
    WHEN 'NAT' THEN COALESCE(answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$', false)
    ELSE COALESCE(answer ~ '^[0-3]$', false)
  END
$function$;

CREATE OR REPLACE FUNCTION public.question_details_error(question_type pg_catalog.text, details pg_catalog.jsonb)
RETURNS pg_catalog.text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
DECLARE
  is_matrix pg_catalog.bool := pg_catalog.upper(COALESCE(question_type, 'MCQ')) OPERATOR(pg_catalog.=) 'MATRIX_MATCH';
  list_name pg_catalog.text;
  list_value pg_catalog.jsonb;
  item pg_catalog.jsonb;
  passage pg_catalog.jsonb;
BEGIN
  IF details IS NULL OR pg_catalog.jsonb_typeof(details) OPERATOR(pg_catalog.=) 'null' THEN
    RETURN CASE WHEN is_matrix THEN 'Matrix match questions require List-I and List-II' END;
  END IF;
  IF pg_catalog.jsonb_typeof(details) OPERATOR(pg_catalog.<>) 'object' THEN RETURN 'Question details must be an object'; END IF;
  IF pg_catalog.octet_length(details::pg_catalog.text) OPERATOR(pg_catalog.>) 32768 THEN RETURN 'Question details must not exceed 32 KiB'; END IF;
  IF (details OPERATOR(pg_catalog.-) ARRAY['matchLists', 'passage']::pg_catalog.text[]) OPERATOR(pg_catalog.<>) '{}'::pg_catalog.jsonb THEN
    RETURN 'Question details contain unsupported fields';
  END IF;

  IF details ? 'matchLists' THEN
    IF NOT is_matrix THEN RETURN 'Only matrix match questions can have List-I and List-II'; END IF;
    IF pg_catalog.jsonb_typeof(details -> 'matchLists') OPERATOR(pg_catalog.<>) 'object'
       OR ((details -> 'matchLists') OPERATOR(pg_catalog.-) ARRAY['left', 'right']::pg_catalog.text[]) OPERATOR(pg_catalog.<>) '{}'::pg_catalog.jsonb THEN
      RETURN 'List-I and List-II are invalid';
    END IF;
    FOREACH list_name IN ARRAY ARRAY['left', 'right'] LOOP
      list_value := details -> 'matchLists' -> list_name;
      IF pg_catalog.jsonb_typeof(list_value) IS DISTINCT FROM 'array'
         OR pg_catalog.jsonb_array_length(list_value) OPERATOR(pg_catalog.<) 2
         OR pg_catalog.jsonb_array_length(list_value) OPERATOR(pg_catalog.>) CASE WHEN list_name OPERATOR(pg_catalog.=) 'left' THEN 6 ELSE 8 END THEN
        RETURN CASE WHEN list_name OPERATOR(pg_catalog.=) 'left' THEN 'List-I must have 2 to 6 items' ELSE 'List-II must have 2 to 8 items' END;
      END IF;
      FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(list_value) LOOP
        IF pg_catalog.jsonb_typeof(item) OPERATOR(pg_catalog.<>) 'string'
           OR pg_catalog.length(pg_catalog.btrim(item #>> '{}')) NOT BETWEEN 1 AND 2000 THEN
          RETURN 'Every List-I and List-II item needs 1 to 2000 characters';
        END IF;
      END LOOP;
    END LOOP;
  ELSIF is_matrix THEN
    RETURN 'Matrix match questions require List-I and List-II';
  END IF;

  IF details ? 'passage' THEN
    passage := details -> 'passage';
    IF pg_catalog.jsonb_typeof(passage) OPERATOR(pg_catalog.<>) 'object'
       OR (passage OPERATOR(pg_catalog.-) ARRAY['key', 'text']::pg_catalog.text[]) OPERATOR(pg_catalog.<>) '{}'::pg_catalog.jsonb
       OR COALESCE(passage ->> 'key', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(passage -> 'text') IS DISTINCT FROM 'string'
       OR pg_catalog.length(pg_catalog.btrim(passage ->> 'text')) NOT BETWEEN 1 AND 10000 THEN
      RETURN 'The paragraph must have a valid key and 1 to 10000 characters of text';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.question_identity_key(question_text pg_catalog.text, details pg_catalog.jsonb)
RETURNS pg_catalog.text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
  SELECT public.canonical_question_text(question_text) OPERATOR(pg_catalog.||) '|' OPERATOR(pg_catalog.||) COALESCE(details::pg_catalog.text, '')
$function$;

REVOKE ALL ON FUNCTION public.question_type_is_option_based(pg_catalog.text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.question_type_is_supported(pg_catalog.text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_canonical_option_set(pg_catalog.text, pg_catalog.int4) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_valid_correct_answer(pg_catalog.text, pg_catalog.text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.question_details_error(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.question_identity_key(pg_catalog.text, pg_catalog.jsonb) FROM PUBLIC, anon;
-- The question bank trigger runs as the calling administrator, and the unique
-- index expression is evaluated for them, so these pure helpers are executable
-- by authenticated (they read no data).
GRANT EXECUTE ON FUNCTION public.question_type_is_option_based(pg_catalog.text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.question_type_is_supported(pg_catalog.text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_canonical_option_set(pg_catalog.text, pg_catalog.int4) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_correct_answer(pg_catalog.text, pg_catalog.text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.question_details_error(pg_catalog.text, pg_catalog.jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.question_identity_key(pg_catalog.text, pg_catalog.jsonb) TO authenticated, service_role;

ALTER TABLE public.question_bank ADD COLUMN IF NOT EXISTS details pg_catalog.jsonb;

ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_data_valid;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_data_valid CHECK (
  public.question_type_is_supported(type) AND type OPERATOR(pg_catalog.=) pg_catalog.upper(type)
  AND pg_catalog.length(pg_catalog.btrim(subject)) BETWEEN 1 AND 120
  AND pg_catalog.jsonb_typeof(options) OPERATOR(pg_catalog.=) 'array'
  AND (
    (public.question_type_is_option_based(type) AND pg_catalog.jsonb_array_length(options) OPERATOR(pg_catalog.=) 4)
    OR (NOT public.question_type_is_option_based(type) AND pg_catalog.jsonb_array_length(options) OPERATOR(pg_catalog.=) 0)
  )
  AND public.is_valid_correct_answer(type, correct_answer)
  AND public.question_details_error(type, details) IS NULL
) NOT VALID;
ALTER TABLE public.question_bank VALIDATE CONSTRAINT question_bank_data_valid;

DROP INDEX IF EXISTS public.question_bank_canonical_text_unique;
CREATE UNIQUE INDEX question_bank_identity_unique
  ON public.question_bank (pg_catalog.md5(public.question_identity_key(question_text, details)))
  WHERE public.canonical_question_text(question_text) OPERATOR(pg_catalog.<>) '';
```

  Then redefine `public.validate_question_bank_content()`:
  - Copy the latest body from `supabase/migrations/20260924140000_configurable_subjects_and_exam_patterns.sql:634-708`, keeping `SET search_path TO 'public', 'pg_temp'`.
  - Replace the type check with `IF NOT public.question_type_is_supported(NEW.type) THEN RAISE EXCEPTION 'Question type is invalid'; END IF;`.
  - Replace `IF NEW.type = 'MCQ' THEN` with `IF public.question_type_is_option_based(NEW.type) THEN`.
  - In that option branch, replace the answer test `NEW.correct_answer !~ '^[0-3]$'` with `NOT public.is_valid_correct_answer(NEW.type, NEW.correct_answer)` and keep the MCQ message for `MCQ`. For other option types raise `'% requires four options and a valid correct answer', NEW.type`.
  - In the ELSE branch, use `NOT public.is_valid_correct_answer(NEW.type, NEW.correct_answer)` in place of the regex, keeping the numerical message for NUMERICAL/NAT and raising `'Integer questions require no options and a whole-number answer'` for INTEGER.
  - Before `NEW.has_image_or_diagram := …` add:

    ```sql
    IF public.question_details_error(NEW.type, NEW.details) IS NOT NULL THEN
      RAISE EXCEPTION '%', public.question_details_error(NEW.type, NEW.details);
    END IF;
    IF NEW.details IS NOT NULL AND NEW.details ? 'passage' THEN
      NEW.details := pg_catalog.jsonb_set(NEW.details, '{passage,text}', pg_catalog.to_jsonb(pg_catalog.btrim(NEW.details #>> '{passage,text}')));
    END IF;
    ```

  Redefine `public.admin_import_questions`:
  - Copy from the same file at `:710-822`. Keep `SET search_path TO ''`, because stage21 pinned it to `''`.
  - Add `'details'` to the allowed keys.
  - Replace `IF item_type NOT IN ('MCQ', 'NUMERICAL')` with `IF item_type NOT IN ('MCQ', 'NUMERICAL', 'MULTIPLE_CORRECT', 'INTEGER', 'MATRIX_MATCH', 'ASSERTION_REASON')`.
  - Branch with `public.question_type_is_option_based(item_type)` instead of `= 'MCQ'`.
  - Validate the answer with `public.is_valid_correct_answer(item_type, item_answer)`, keeping the two existing messages for MCQ and NUMERICAL.
  - Read `item_details := CASE WHEN jsonb_typeof(item->'details') = 'object' THEN item->'details' END`. Reject a `details` key that is present but not an object or null with `'Question details must be an object'`. Raise `question_details_error` if it is non-null.
  - Change the duplicate check to `public.question_identity_key(question_text, details) = public.question_identity_key(item_text, item_details)`.
  - Insert `details`.

  Redefine `public.get_admin_question_bank_page` (from `:824-917`):
  - Accept `normalized_type` when `public.question_type_is_supported(normalized_type)`.
  - The filter predicate becomes `(normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT','NUMERICAL') THEN 'NUMERICAL' ELSE upper(question.type) END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)`. Update it in both CTEs.
  - Add `'details', question.details` to the payload.

  Redefine `public.get_admin_questions_by_ids`:
  - Copy from `supabase/migrations/20260910300000_stage19_paginated_question_bank.sql:108-150`, keeping its `SET search_path`.
  - Add `'details', question.details`.

  Add:

  ```sql
  CREATE OR REPLACE FUNCTION public.admin_update_passage(passage_key_param pg_catalog.uuid, passage_text_param pg_catalog.text)
  RETURNS pg_catalog.int4 LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
  AS $function$
  DECLARE
    cleaned pg_catalog.text := pg_catalog.btrim(COALESCE(passage_text_param, ''));
    updated_count pg_catalog.int4;
  BEGIN
    IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required'; END IF;
    IF passage_key_param IS NULL THEN RAISE EXCEPTION 'Paragraph key is required'; END IF;
    IF pg_catalog.length(cleaned) NOT BETWEEN 1 AND 10000 THEN
      RAISE EXCEPTION 'Paragraph text must contain between 1 and 10000 characters';
    END IF;
    UPDATE public.question_bank AS q
    SET details = pg_catalog.jsonb_set(q.details, '{passage,text}', pg_catalog.to_jsonb(cleaned))
    WHERE q.details -> 'passage' ->> 'key' OPERATOR(pg_catalog.=) passage_key_param::pg_catalog.text;
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
  END;
  $function$;
  REVOKE ALL ON FUNCTION public.admin_update_passage(pg_catalog.uuid, pg_catalog.text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.admin_update_passage(pg_catalog.uuid, pg_catalog.text) TO authenticated;
  ```

- [ ] **Run the new test file.** Expected: PASS. Then run `npm run -s test:db`. Expected: all pass.
- [ ] **Commit:** `feat(db): question details, new question types in the bank and import`.

### Task 2: Exam paper validation, per-type marking, patterns, and block shuffle

**Files:** append to `supabase/migrations/20260928100000_question_types.sql`; extend `tests/db/question-types.test.mjs`; modify `tests/db/migrations-replay.test.mjs` (new template signature), `tests/db/subjects-patterns.test.mjs` (9-argument calls).

**Interfaces (produces):**
- `public.normalize_exam_marking(marking jsonb) → jsonb`: raises on invalid input, returns NULL for NULL or JSON null.
- `public.resolve_question_marking(paper jsonb, question_type text) → jsonb {correct numeric, incorrect numeric, partial boolean}`.
- `public.paper_question_error(q jsonb) → text`: all per-question structure checks (options, answer if present, details), with the existing MCQ messages. NULL when valid.
- `exam_templates.marking jsonb NULL`.
- `public.admin_save_exam_template(uuid, text, text, integer, numeric, numeric, jsonb, boolean, jsonb)`: `marking_param jsonb DEFAULT NULL` is the new last argument, and the old 8-argument signature is dropped.
- `admin_list_exam_templates()` rows gain `marking`.

Steps:

- [ ] **Write the failing tests:**
  - an exam paper containing every new type plus a passage pair is created through the `cbt_exams` view, then activated
  - a paper with an invalid `marking` is rejected, for example `{"MULTIPLE_CORRECT": {"correct": 0}}`, `{"MCQ": {"partial": true}}`, or `{"ESSAY": {}}`
  - a matrix question without lists in the paper is rejected
  - `resolve_question_marking` falls back correctly
  - template save and list round-trips `marking`
  - start the exam 20 times for 20 students: in every `jumbled_exam_data`, the two passage questions are adjacent and keep paper order, and every subject keeps its question count and ID set
- [ ] **Run the tests.** Expected: FAIL.
- [ ] **Implement:**
  - `normalize_exam_marking`:
    - The object keys must satisfy `question_type_is_supported` and must not be `NAT`.
    - Each value is an object whose keys are a subset of `{correct, incorrect, partial}`.
    - `correct` is a JSON number in (0,100] with at most 2 decimal places; `incorrect` is a JSON number in [−100,0] with at most 2 decimal places.
    - `partial` is a JSON boolean, allowed only under `MULTIPLE_CORRECT`.
    - Return the input unchanged.
  - `resolve_question_marking(paper, t)`: set `key := CASE WHEN upper(t) IN ('NAT','NUMERICAL') THEN 'NUMERICAL' ELSE upper(t) END` and return `jsonb_build_object('correct', COALESCE((paper->'marking'->key->>'correct')::numeric, (paper->>'marksCorrect')::numeric, 4), 'incorrect', COALESCE((paper->'marking'->key->>'incorrect')::numeric, (paper->>'marksIncorrect')::numeric, -1), 'partial', COALESCE((paper->'marking'->key->>'partial')::boolean, true))`.
  - `paper_question_error(q)`: move the per-question type branch of `validate_full_exam_paper_internal` into it.
    - Use the type check `question_type_is_supported`.
    - Option-bearing types run the existing 4-option loop and messages (`MCQ question "%" …`). For `MCQ`, the word is "MCQ"; for other option types, use the type code.
    - The answer check runs only when `correctAnswer` or `correct_answer` is present in `q`, because the raw validator sees stripped papers. It converts A–D for single-answer option types first, then calls `is_valid_correct_answer`, keeping the existing messages.
    - Value types reject non-empty options with the existing message.
    - Then return `question_details_error(type, q->'details')`.
  - Redefine `validate_full_exam_paper_internal(text, jsonb)`:
    - Copy the full body from `20260910090000_deep_exam_data_validation.sql:9-222`, renamed.
    - `SET search_path = ''` with `public.`-qualified calls.
    - Replace the per-question type block with `v_err := public.paper_question_error(v_q); IF v_err IS NOT NULL THEN RAISE EXCEPTION 'Exam validation failed: %', v_err; END IF;`.
    - Add `PERFORM public.normalize_exam_marking(p_questions_data->'marking');` after the marks checks.
    - `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`, matching the old grant.
  - Redefine `validate_cbt_exams_raw_record()`:
    - Copy from `20260910090000:225-383`, `SET search_path = ''`.
    - Use the same `paper_question_error` call for every question, plus `normalize_exam_marking`.
  - `handle_cbt_exams_modification` needs no change: the A–D conversion only touches single letters.
  - `exam_templates`:
    - `ALTER TABLE … ADD COLUMN marking jsonb`
    - `DROP FUNCTION public.admin_save_exam_template(uuid, text, text, integer, numeric, numeric, jsonb, boolean);`
    - `CREATE FUNCTION` with the appended `marking_param jsonb DEFAULT NULL`, copied from `20260924140000:366-432`, which stores `public.normalize_exam_marking(marking_param)`
    - re-apply the same `REVOKE`/`GRANT` statements as the original; grep for them in `20260924140000`
  - Redefine `admin_list_exam_templates()` to add `'marking', t.marking`.
  - Redefine `start_exam_session_internal`:
    - Copy the latest from `20260925120000:268-463`.
    - Replace the per-subject `jsonb_agg(question ORDER BY random())` with:

    ```sql
    WITH items AS (
      SELECT question.value AS question, question.ordinality AS position,
        COALESCE(question.value -> 'details' -> 'passage' ->> 'key', 'q' OPERATOR(pg_catalog.||) question.ordinality::pg_catalog.text) AS block
      FROM pg_catalog.jsonb_array_elements(exam_row.questions_data -> 'questions' -> subject_name) WITH ORDINALITY AS question
    ), blocks AS (
      SELECT items.block, pg_catalog.random() AS draw FROM items GROUP BY items.block
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(items.question ORDER BY blocks.draw, items.position), '[]'::pg_catalog.jsonb)
    INTO shuffled_subject
    FROM items JOIN blocks ON blocks.block OPERATOR(pg_catalog.=) items.block;
    ```
- [ ] **Update `migrations-replay.test.mjs`** to the 9-argument signature. Update the `subjects-patterns.test.mjs` calls; they still work with 8 positional arguments because of the default, so change only the signature list.
- [ ] **Run `npm run -s test:db`.** Expected: all pass.
- [ ] **Commit:** `feat(db): per-type marking, pattern marking, and passage-safe shuffle`.

### Task 3: Candidate answer validation, grading, partial counter, and review

**Files:**
- Append to the migration; extend `tests/db/question-types.test.mjs`.
- Modify `tests/db/exam-submission.test.mjs`: add `partial: 0` to the expected result objects.
- Modify every other DB test that uses `deepEqual` on a `submit_exam` result or `get_student_exam_result`; grep for `unattempted:`.

**Interfaces (produces):**
- `public.response_value_error(question_type text, option_count integer, selected text) → text`. Returns NULL when valid, otherwise one of these messages:
  - `'Invalid numerical response'`
  - `'Invalid MCQ option'`
  - `'MCQ option is out of range'`
  - `'Invalid multiple-correct response'`
  - `'Invalid integer response'`
- `public.score_question_response(question_type text, correct_answer text, selected text, marking jsonb) → jsonb {outcome: 'CORRECT'|'PARTIAL'|'INCORRECT'|'UNATTEMPTED', marks: numeric}`. `selected` NULL means unattempted.
- `student_results.partial integer NOT NULL DEFAULT 0 CHECK (partial >= 0)`.
- `student_result_reviews.snapshot_format text NOT NULL DEFAULT 'legacy_position' CHECK (snapshot_format IN ('legacy_position','by_question_id'))`, and `question_scores jsonb`.
- `submit_exam` / `get_student_exam_result` return a `partial` key.
- `get_admin_student_result_review` returns `snapshot_format` and `question_scores`.

Steps:

- [ ] **Write the failing tests:**
  - `score_question_response` table test with `marking {correct:4, incorrect:-2, partial:true}`:
    - C = `"0,1,2,3"`: S `"0,1,2"` → PARTIAL 3; S `"0,1,2,3"` → CORRECT 4
    - C = `"0,1,2"`: S `"0,1"` → PARTIAL 2; S `"0,3"` → INCORRECT −2
    - C = `"1,3"`: S `"1"` → PARTIAL 1
    - C = `"2"`: S `"2"` → CORRECT 4; S `"1,2"` → INCORRECT −2
    - S NULL → UNATTEMPTED 0
    - partial false: C `"0,1,2"`, S `"0,1"` → INCORRECT −2
    - full 3: C `"0,1,2,3"`, S `"0"` → PARTIAL 0.75
  - Other types:
    - INTEGER `"-012"` vs `"-12"` → CORRECT
    - NUMERICAL `"2.50"` vs `"2.5"` → CORRECT
    - MATRIX_MATCH and ASSERTION_REASON index equality
  - Autosave with `sync_active_session_progress` rejects each of `"2,0"`, `"0,0"`, `"0,,2"`, `"4"`, `["0","2"]`, and `"2.5"` for an INTEGER question with the matching message, and accepts `"0,2"`.
  - Full exam:
    - JEE Advanced marking: MCQ +3/−1, MULTIPLE_CORRECT +4/−2 partial, INTEGER +4/0, MATRIX_MATCH +3/−1
    - answers produce the exact `totalScore`, `maxScore` (the sum of per-type full marks), and `correct`/`partial`/`incorrect`/`unattempted`
    - the `student_results.partial` column matches
    - `get_student_exam_result` returns the same values
    - the review RPC for that result returns `snapshot_format 'by_question_id'`, `responses` keyed by question ID, and `question_scores` equal to the per-question outcomes
  - Legacy grading regression: `defaultPaper()` with no marking gives the same totals as `exam-submission.test.mjs` (that file's expectations only gain `partial: 0`).
- [ ] **Run the tests.** Expected: FAIL.
- [ ] **Implement `response_value_error`:**

```sql
CREATE OR REPLACE FUNCTION public.response_value_error(question_type pg_catalog.text, option_count pg_catalog.int4, selected pg_catalog.text)
RETURNS pg_catalog.text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = ''
AS $function$
  SELECT CASE
    WHEN selected IS NULL THEN NULL
    WHEN pg_catalog.upper(COALESCE(question_type, 'MCQ')) IN ('NUMERICAL', 'NAT') THEN
      CASE WHEN pg_catalog.length(selected) > 64 OR selected !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN 'Invalid numerical response' END
    WHEN pg_catalog.upper(question_type) = 'INTEGER' THEN
      CASE WHEN pg_catalog.length(selected) > 64 OR selected !~ '^[+-]?[0-9]+$' THEN 'Invalid integer response' END
    WHEN pg_catalog.upper(question_type) = 'MULTIPLE_CORRECT' THEN
      CASE WHEN NOT public.is_canonical_option_set(selected, COALESCE(option_count, 0)) THEN 'Invalid multiple-correct response' END
    WHEN selected !~ '^[0-9]+$' THEN 'Invalid MCQ option'
    WHEN pg_catalog.length(selected) > 9 OR selected::pg_catalog.int4 >= COALESCE(option_count, 0) THEN 'MCQ option is out of range'
  END
$function$;
```

  Then redefine `sanitize_exam_responses` and `normalize_submission_response_map`:
  - Copy both from `20260910160000_stage3_integrity_corrections.sql`, keeping `SET search_path = public, pg_temp` and declaring `STABLE`, which matches the stage21 volatility correction.
  - Replace each `IF question_type IN ('NUMERICAL','NAT') … END IF;` block with the following. In the normalize function, drop the ` at %.%` suffix and arguments to keep its current messages:

    ```sql
    response_error := public.response_value_error(
      question_type,
      CASE WHEN jsonb_typeof(question_item->'options') = 'array' THEN jsonb_array_length(question_item->'options') ELSE 0 END,
      selected_text);
    IF response_error IS NOT NULL THEN RAISE EXCEPTION '% at %.%', response_error, subject_name, idx; END IF;
    ```

  - Re-apply `REVOKE ALL … FROM PUBLIC`.
- [ ] **Implement `score_question_response`** (plpgsql IMMUTABLE, `SET search_path = ''`):

```sql
DECLARE
  qtype pg_catalog.text := pg_catalog.upper(COALESCE(question_type, 'MCQ'));
  full_marks pg_catalog.numeric := (marking ->> 'correct')::pg_catalog.numeric;
  wrong_marks pg_catalog.numeric := (marking ->> 'incorrect')::pg_catalog.numeric;
  chosen pg_catalog.text[];
  correct_set pg_catalog.text[];
BEGIN
  IF NULLIF(pg_catalog.btrim(COALESCE(selected, '')), '') IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'UNATTEMPTED', 'marks', 0);
  END IF;
  IF qtype IN ('NUMERICAL', 'NAT', 'INTEGER') THEN
    IF pg_catalog.abs(selected::pg_catalog.numeric - correct_answer::pg_catalog.numeric) < 0.00001 THEN
      RETURN pg_catalog.jsonb_build_object('outcome', 'CORRECT', 'marks', full_marks);
    END IF;
  ELSIF qtype = 'MULTIPLE_CORRECT' THEN
    chosen := pg_catalog.string_to_array(selected, ',');
    correct_set := pg_catalog.string_to_array(correct_answer, ',');
    IF chosen = correct_set THEN
      RETURN pg_catalog.jsonb_build_object('outcome', 'CORRECT', 'marks', full_marks);
    ELSIF chosen <@ correct_set AND COALESCE((marking ->> 'partial')::pg_catalog.bool, true) THEN
      RETURN pg_catalog.jsonb_build_object('outcome', 'PARTIAL',
        'marks', pg_catalog.round(full_marks * pg_catalog.cardinality(chosen) / 4, 2));
    END IF;
  ELSIF selected = correct_answer THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'CORRECT', 'marks', full_marks);
  END IF;
  RETURN pg_catalog.jsonb_build_object('outcome', 'INCORRECT', 'marks', wrong_marks);
END;
```

  Redefine `submit_exam_internal`, copying from `20260925120000:26-266`:
  - Declare `partial_count int4 := 0`, `max_score numeric := 0`, `question_scores jsonb := '{}'`, `marking jsonb`, `score jsonb`, `delta numeric`, `outcome text`, `new_result_id uuid`.
  - In the loop:
    - `marking := public.resolve_question_marking(session_row.jumbled_exam_data, answer_data->>'type')`
    - `max_score := max_score + (marking->>'correct')::numeric`
    - `score := public.score_question_response(answer_data->>'type', answer_data->>'correct_answer', CASE WHEN is_attempted THEN response_data->>'selected_option' END, marking)`
    - `outcome := score->>'outcome'`, `delta := (score->>'marks')::numeric`
    - increment the counter for that outcome, add `delta` to `total_score` and to `subject_scores[subject_name]`
    - `question_scores := jsonb_set(question_scores, ARRAY[answer_entry.key], score, true)`
  - The INSERT adds `partial` and uses `max_score`, with `RETURNING id INTO new_result_id`.
  - After the insert:

    ```sql
    IF new_result_id IS NOT NULL THEN
      INSERT INTO public.student_result_reviews (result_id, exam_id, student_id, response_snapshot, subject_time_seconds, snapshot_format, question_scores)
      VALUES (new_result_id, exam_id_param, student_row.student_id, response_map, COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb), 'by_question_id', question_scores)
      ON CONFLICT (result_id) DO UPDATE SET response_snapshot = EXCLUDED.response_snapshot,
        snapshot_format = EXCLUDED.snapshot_format, question_scores = EXCLUDED.question_scores;
    END IF;
    ```

  - Both `RETURN jsonb_build_object(...)` calls add `'partial', result_row.partial`.
  - Delete the now-unused `is_correct`, `user_val`, and `correct_val`.
  - Redefine `get_student_exam_result` (from `20260912103415:193-242`) to add `'partial'`.
  - Redefine `get_admin_student_result_review` (from `20260923143000:192-252`) to add `'snapshot_format'` and `'question_scores'`.
  - `COMMIT;` closes the migration.
- [ ] **Update `partial: 0` in existing DB test expectations;** grep `tests/db` for `unattempted`.
- [ ] **Run `npm run -s test:db`.** Expected: all pass.
- [ ] **Commit:** `feat(db): shared answer grammar, partial-mark grading, and graded answer reviews`.

### Task 4: Client question-type registry

**Files:**
- Create: `src/questionTypes.js`
- Create: `tests/question-types.test.mjs`
- Modify: `src/numericalAnswerPolicy.js` (add the integer grammar)
- Modify: `src/types.d.ts`
- Modify: the `lint:syntax` script in `package.json` (add `src/questionTypes.js`)

**Interfaces (produces) from `src/questionTypes.js`:**
- `QUESTION_TYPES`: ordered array of `{ code, label, badge, optionBased, valueKind: 'decimal'|'integer'|null }` for the six authorable codes, in the order MCQ, MULTIPLE_CORRECT, INTEGER, NUMERICAL, MATRIX_MATCH, ASSERTION_REASON.
- `normalizeQuestionType(value) → string`: upper-cases and maps `NAT` to `NUMERICAL`. Unknown non-empty values are returned upper-cased and are never silently turned into MCQ. Empty becomes `'MCQ'`.
- `questionTypeInfo(code) → entry | null`, `isOptionBased(code) → boolean`, `isValueType(code) → boolean`.
- `encodeOptionSet(indices: number[]) → string | null` (sorted, deduped, `null` when empty) and `decodeOptionSet(value) → number[]`.
- `isValidAuthorAnswer(type, answer: string) → boolean`: the same rules as SQL `is_valid_correct_answer`.
- `formatAnswer(question, value) → string`, for example `"A. text"`, `"A, C"`, or `"42"`.
- `resolveMarking(paper, type) → { correct, incorrect, partial }`: the same rules as SQL `resolve_question_marking`.
- `ASSERTION_REASON_OPTIONS`: the 4 standard option strings. `ASSERTION_REASON_TEMPLATE = 'Assertion (A): \n\nReason (R): '`.
- `MATCH_LEFT_LABELS = ['P','Q','R','S','T','U']`, `MATCH_RIGHT_LABELS = ['1','2','3','4','5','6','7','8']`.
- `validateMatchLists(lists) → string | null` and `validatePassage(passage) → string | null`: the same rules as SQL `question_details_error`.
- `questionIdentityKey(text, details) → string`: `canonicalQuestionText(text) + '|' + stableDetailsText(details)`. Tests prove that JS and PostgreSQL produce equal keys for equal inputs where it matters, which is duplicate detection inside one browser session.

`numericalAnswerPolicy.js` adds `validateIntegerAnswer(value, maxLength = 64)`, returning the same shape as `validateNumericalAnswer`, with `COMPLETE_INTEGER = /^[+-]?\d+$/` and the transient forms `-`/`+`.

Steps:
- [ ] **Write `tests/question-types.test.mjs`** (node:test) covering every export, including the 15 marking and partial cases mirrored from Task 3 via `resolveMarking`, and `encodeOptionSet([2,0,2]) === '0,2'`.
- [ ] **Run `node --test tests/question-types.test.mjs`.** Expected: FAIL.
- [ ] **Implement,** and add the JSDoc types to `types.d.ts`: `QuestionTypeCode`, `QuestionDetails`, `MarkingEntry`, `ExamMarking`. Add `details?: QuestionDetails | null` to `ExamQuestion`, `marking?: ExamMarking` to `ExamPaper`, widen `QuestionBankItem.type` to `QuestionTypeCode`, and widen `ImportQuestionType`.
- [ ] **Run the test, `npm run -s typecheck`, and `npm run -s lint`.** Expected: PASS.
- [ ] **Commit:** `feat: question type registry`.

### Task 5: Client logic modules

**Files:**
- Modify:
  - `src/questionContentLogic.js`
  - `src/questionBankPaging.js`
  - `src/examPreflightLogic.js`
  - `src/examPatternLogic.js`
  - `src/features/admin/wizard/wizardLogic.js`
  - `src/features/admin/questions/useExamBuilder.js` (`assembleExamRecord`)
  - `src/features/exam/examSessionHelpers.js` (`shuffleArray` becomes block-aware)
  - `src/importLogic.js`
- Tests: extend `tests/question-content-logic.test.mjs`, `tests/question-import-logic.test.mjs`, `tests/stage19-question-bank-pagination.test.mjs`, and the preflight tests (`tests/stage9-preflight-assets.test.mjs`); add a wizard test for marks totals in `tests/components/admin/ExamCreationWizard.test.jsx` if the logic lives there.

**Behaviour:**
- **`prepareQuestionDraft`:**
  - keeps 4 options for option-based types and `[]` otherwise
  - validates the answer with `isValidAuthorAnswer`, with the messages "Choose at least one correct option." for multiple correct, "Enter a whole-number answer." for integer, and the existing texts otherwise
  - validates details with `validateMatchLists` and `validatePassage`
  - returns `details` (null when empty)
  - duplicate detection uses `questionIdentityKey`
- **`normalizeQuestionBankRow`** uses `normalizeQuestionType` and carries `details`.
- **`validateExamPreflight`** accepts every supported type, using the same rules through the registry, and validates `marking` via `validateMarking`.
- **`examPatternLogic`** gains `validateMarking(marking) → string[]` (errors), used by `validateExamSettings` and `validatePatternDraft`, with the same bounds as SQL `normalize_exam_marking`.
- **`summarizeSelection`** totals marks as the sum of `resolveMarking(paper, q.type).correct`.
- **`assembleExamRecord`:**
  - includes `marking` when it is non-empty
  - orders each subject's questions so passage siblings are contiguous: a stable sort by the first index where each passage key appears
- **`shuffleArray(questions)`** shuffles blocks (passage key, or each question alone) and keeps in-block order.
- **`importLogic`:**
  - the schema enum gains the new types
  - `correct_answer` for `MULTIPLE_CORRECT` accepts `"A,C"`, `["A","C"]`, or `"0,2"`
  - new `match_lists {list_i, list_ii}` and `passage {key, text}` fields
  - new error codes `ROW_INVALID_MULTI_ANSWER`, `ROW_INVALID_INTEGER_ANSWER`, `ROW_INVALID_MATCH_LISTS`, and `ROW_PASSAGE_MISMATCH`
  - `buildAtomicImportPayload` maps each file-local passage key to one `crypto.randomUUID()` per call and emits `details`
  - failed-row export writes the new fields back in file format

Steps:
- [ ] **Write the failing tests for each behaviour above,** one `test()` per bullet.
- [ ] **Run `npm test`.** Expected: the new tests FAIL.
- [ ] **Implement.**
- [ ] **Run `npm test`, `npm run -s typecheck`, and `npm run -s lint`.** Expected: PASS.
- [ ] **Commit:** `feat: client validation, import, and exam assembly for new question types`.

### Task 6: Student exam interface

**Files:**
- Modify:
  - `src/components/QuestionPanel.jsx`
  - `src/components/PreExam.jsx`
  - `src/components/Result.jsx`
  - `src/components/StudentDashboard.jsx` (select `partial`)
  - `src/features/exam/examSessionHelpers.js` (`committedResultToScorecard` adds `partial`)
- Tests:
  - `tests/components/QuestionPanel.test.jsx`
  - `tests/components/PreExam.test.jsx`
  - `tests/exam-logic.test.mjs`: `mergeOfflineResponses` keeps `"0,2"`

**Behaviour:**
- **Multiple correct:**
  - `role="group"` labelled by the prompt, with 4 `type="checkbox"` inputs named `A. …`
  - toggling calls `setSelectedOption(encodeOptionSet(next))`, which is null when nothing is ticked
  - badge `MULTIPLE CORRECT`
  - hint "One or more options may be correct."
- **Integer:**
  - the numerical input and keypad with `inputMode="numeric"`, and the `.` key omitted
  - validation via `validateIntegerAnswer`
  - badge `INTEGER TYPE`
  - The existing numerical code path and its contract strings in `tests/stage16-numerical-answer-policy.test.mjs` stay byte-identical: the validator function is chosen by type, and the lines those tests match stay unchanged.
- **Matrix match:** a table (`<table>` with `<caption>` "List-I and List-II") of P…/1… rows above the options radio group, with badge `MATRIX MATCH`.
- **Assertion–reason:** badge `ASSERTION–REASON`; otherwise identical to MCQ.
- **Passage:** when `question.details?.passage`, a `<section aria-label="Paragraph">` with `MathRenderer` text above the question text.
- **Pre-exam screen:** when `marking` has entries, lists "Label: +x / −y" per entry, with "(partial marks)" for multiple correct, and keeps the default rule line.
- **Result:** shows a "Partially Correct" `StatCard` when `partial > 0`.

Steps:
- [ ] **Write the failing component tests:**
  - ticking A then C calls `setSelectedOption('0,2')`
  - unticking the only box calls `setSelectedOption(null)`
  - the integer keypad has no `.` key, and typing `2.5` saves only `'2'`
  - the match table renders the list items with P/1 labels
  - the passage section renders
  - PreExam shows per-type marks
  - Result shows the partial card only when `partial > 0`
- [ ] **Run `npm run -s test:components`.** Expected: FAIL.
- [ ] **Implement,** keeping `export default memo(QuestionPanel)` and the class names asserted by `tests/production-contracts.test.mjs`.
- [ ] **Run `npm run -s test:components` and `npm test`.** Expected: PASS.
- [ ] **Commit:** `feat(exam): candidate UI for new question types and partial results`.

### Task 7: Admin authoring (editor and bank)

**Files:**
- Modify:
  - `src/components/QuestionEditor.jsx`
  - `src/features/admin/questions/useQuestionBank.js` (save `details`; `handleAddBlankQuestion(type, passage?)`; `handleUpdatePassage(key, text)` → `supabase.rpc('admin_update_passage', …)`)
  - `src/features/admin/questions/QuestionBankView.jsx`
- Tests: `tests/components/QuestionEditor.test.jsx`, plus a new `tests/components/QuestionBankView.test.jsx` if none exists.

**Behaviour:**
- **Editor:**
  - the type select lists `QUESTION_TYPES`
  - multiple correct shows 4 "Correct" checkboxes
  - integer shows a text input with `inputMode="numeric"`
  - matrix match shows List-I/List-II row editors (add and remove within 2–6 and 2–8) plus the options and single answer
  - choosing assertion–reason fills `ASSERTION_REASON_TEMPLATE` and `ASSERTION_REASON_OPTIONS`, asking `customConfirm` first if the text or options are non-empty
  - the passage is a textarea when `question.details.passage` is new (`isNewPassage`), and otherwise read-only text with "Edit it from the question bank"
  - the preview uses the registry
- **Bank:**
  - the create buttons become a type menu plus "New paragraph set"
  - the type filter lists every type
  - each card shows the answer via `formatAnswer`, the match lists, and a passage excerpt with "Add question to this passage" and "Edit passage" (a prompt dialog → `handleUpdatePassage`, then reload)

Steps:
- [ ] **Write the failing tests:**
  - selecting Multiple correct and ticking B and D saves `correctAnswer: '1,3'`
  - the Assertion–Reason template fills the options
  - the matrix editor adds a List-II row
  - "Add question to this passage" opens the editor with the passage read-only
  - "Edit passage" calls the RPC
- [ ] **Run.** Expected: FAIL.
- [ ] **Implement.**
- [ ] **Run the component, unit, lint, and type-check suites.** Expected: PASS.
- [ ] **Commit:** `feat(admin): author new question types and paragraph sets`.

### Task 8: Admin exam building, patterns, archive, and answer review

**Files:**
- Modify:
  - `src/features/admin/wizard/MarkingStep.jsx`
  - `src/features/admin/questions/CreateExamCard.jsx`
  - a new shared `src/features/admin/shared/TypeMarkingTable.jsx`, used by both of those and by the pattern editor
  - `src/features/admin/wizard/QuestionsStep.jsx`
  - `src/features/admin/wizard/ReviewStep.jsx`
  - `src/features/admin/wizard/ExamCreationWizard.jsx` (marking state)
  - `src/features/admin/questions/useExamBuilder.js` (marking state)
  - `src/components/SubjectsAndPatternsView.jsx` (`marking_param`)
  - `src/components/ExamQuestionsArchive.jsx`
  - `src/features/admin/exams/StudentAnswerReviewModal.jsx`
- Tests:
  - `tests/components/admin/ExamCreationWizard.test.jsx`
  - `tests/components/SubjectsAndPatternsView.test.jsx` (the RPC arguments gain `marking_param`)
  - a new `tests/components/StudentAnswerReviewModal.test.jsx`

**Behaviour:**
- **`TypeMarkingTable`** takes `types`, `marking`, `defaults`, `onChange`, and `locked`.
  - It renders one row per type with Correct and Wrong number inputs, whose blank placeholders show the default.
  - The multiple-correct row adds a "Partial marks" checkbox that is on by default.
  - It emits a marking object that contains only the fields the user set.
- **Wizard and card:** show the table for the types in the selection.
- **Pattern:** the table appears in the pattern editor for all six types; an exam created from a pattern copies and locks its marking.
- **Review modal:**
  - with `snapshot_format === 'by_question_id'`, it pairs by `question.id`
  - the outcome badge comes from `question_scores[qid].outcome`: Correct, Partial (+marks), Wrong, or Unanswered
  - it shows marks and uses `formatAnswer`
  - with `'legacy_position'`, it shows the notice from spec section 6 and hides the per-question list

Steps:
- [ ] **Write the failing tests** for the table output, the wizard record's `marking`, the pattern RPC arguments, and the review modal in both formats.
- [ ] **Run.** Expected: FAIL.
- [ ] **Implement.**
- [ ] **Run everything.** Expected: PASS.
- [ ] **Commit:** `feat(admin): per-type marking, pattern marking, and graded answer review`.

### Task 9: Importer interface and documentation

**Files:**
- Modify: `src/components/AIQuestionImporter.jsx` (the per-row type select from `QUESTION_TYPES`, per-type answer inputs, match-list and passage display, and the AI prompt rules)
- Modify: `docs/REVIEWED_JSON_IMPORT.md` (new fields, examples, error codes)
- Modify: `docs/STAGE21_AUTHORIZATION_MANIFEST.md` (add `admin_update_passage(uuid, text)`)
- Modify: `docs/SCHEMA_REFERENCE.md` (regenerate with `npm run schema:reference`)
- Tests: `tests/stage23-reviewed-json-import.test.mjs` and `tests/stage18-question-import-recovery.test.mjs` if their source-contract strings changed; a component test that a `MULTIPLE_CORRECT` row with `"A,C"` shows as approved.

Steps:
- [ ] **Write the failing tests.**
- [ ] **Implement.**
- [ ] **Run** the unit, component, lint, type-check, and `schema:reference:check` suites. Expected: PASS.
- [ ] **Commit:** `feat(import): new question types in reviewed JSON import`.

### Task 10: End to end and full verification

**Files:** `e2e/global-setup.mjs` (fixture paper gains one `MULTIPLE_CORRECT` question in Mathematics), `e2e/student-exam.spec.mjs` (tick two options, expect the updated score).

Steps:
- [ ] **Update the fixture and spec.**
- [ ] **Run every gate:**
  - `npm run lint`
  - `npm run typecheck`
  - `npm run schema:reference:check`
  - `npm run test:components`
  - `npm run test:db`
  - `npm run test:coverage` (the 85% line, 70% branch, and 90% function gates must hold)
  - `npm run build`
  - `npm audit --audit-level=high`
- [ ] **If Docker is available,** run `npm run test:e2e:local -- e2e/student-exam.spec.mjs e2e/admin-critical.spec.mjs`.
- [ ] **Walk through the running app** (`npm run dev` against local Supabase if available):
  - create one question of each type and a paragraph set
  - build an exam with JEE Advanced marking
  - take it as a student
  - check the scorecard and the admin review
- [ ] **Commit:** `test(e2e): multiple-correct question in the student journey`.
