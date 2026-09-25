-- F1: administrator-configured subjects and reusable exam patterns.
--
-- Replaces the hard-coded Physics / Chemistry / Mathematics list with a subjects
-- table, and adds exam templates (patterns such as JEE Main or a NEET mock)
-- that pre-fill an exam's structure, duration and marking scheme.
--
-- Safety rules:
-- * Existing exam papers are immutable snapshots; they keep their subject names.
-- * A subject that is used by questions, patterns or exams cannot be renamed or
--   deleted (that would orphan data). It can be deactivated instead, which only
--   stops new questions and patterns from using it.
-- * All writes go through audited SECURITY DEFINER functions; the tables have
--   no direct write grants for signed-in users.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
    CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 60
           AND name ~ '^[[:alnum:]][[:alnum:] &().,/+''-]*$'),
  display_order integer NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subjects_name_ci_key ON public.subjects (lower(name));
CREATE INDEX subjects_display_order_idx ON public.subjects (display_order, name);

CREATE TABLE public.exam_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  marks_correct numeric(6,2) NOT NULL CHECK (marks_correct > 0 AND marks_correct <= 100),
  marks_incorrect numeric(6,2) NOT NULL CHECK (marks_incorrect BETWEEN -100 AND 0),
  -- [{"subject": "Physics", "questionCount": 25}, ...] in exam order
  sections jsonb NOT NULL CHECK (jsonb_typeof(sections) = 'array'),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exam_templates_name_ci_key ON public.exam_templates (lower(name));

ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subjects, public.exam_templates FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.subjects, public.exam_templates TO service_role;

-- Seed the subjects every existing installation already uses, plus the JEE Main pattern.
INSERT INTO public.subjects (name, display_order) VALUES
  ('Physics', 1), ('Chemistry', 2), ('Mathematics', 3);
INSERT INTO public.exam_templates (name, description, duration_minutes, marks_correct, marks_incorrect, sections)
VALUES (
  'JEE Main',
  'Physics, Chemistry and Mathematics with 25 questions each.',
  180, 4, -1,
  '[{"subject":"Physics","questionCount":25},{"subject":"Chemistry","questionCount":25},{"subject":"Mathematics","questionCount":25}]'
);

-- Canonical name of an active subject (NULL if none). SECURITY DEFINER so the
-- question validation trigger can use it without granting table access.
CREATE FUNCTION public.resolve_active_subject(subject_name_param text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT s.name FROM public.subjects AS s
  WHERE lower(s.name) = lower(btrim(COALESCE(subject_name_param, ''))) AND s.is_active;
$function$;
REVOKE ALL ON FUNCTION public.resolve_active_subject(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_active_subject(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Usage helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.subject_usage(subject_name_param text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT jsonb_build_object(
    'questions', (SELECT count(*) FROM public.question_bank AS q
                  WHERE lower(q.subject) = lower(subject_name_param)),
    'templates', (SELECT count(*) FROM public.exam_templates AS t
                  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.sections) AS s
                                WHERE lower(s->>'subject') = lower(subject_name_param))),
    'activeTemplates', (SELECT count(*) FROM public.exam_templates AS t
                  WHERE t.is_active AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.sections) AS s
                                WHERE lower(s->>'subject') = lower(subject_name_param))),
    'exams', (SELECT count(*) FROM public.cbt_exams_raw AS e
              WHERE jsonb_typeof(e.questions_data->'subjects') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.questions_data->'subjects') AS x
                            WHERE lower(btrim(x)) = lower(subject_name_param)))
  );
$function$;
REVOKE ALL ON FUNCTION public.subject_usage(text) FROM PUBLIC, anon, authenticated;

-- Validates and canonicalises template sections against the subjects table.
CREATE FUNCTION public.normalize_exam_template_sections(sections_param jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  section jsonb;
  subject_row public.subjects%ROWTYPE;
  question_count integer;
  seen text[] := ARRAY[]::text[];
  normalized jsonb := '[]'::jsonb;
  total integer := 0;
BEGIN
  IF sections_param IS NULL OR jsonb_typeof(sections_param) <> 'array' THEN
    RAISE EXCEPTION 'A pattern needs a list of subject sections';
  END IF;
  IF jsonb_array_length(sections_param) = 0 THEN
    RAISE EXCEPTION 'Add at least one subject section to the pattern';
  END IF;
  IF jsonb_array_length(sections_param) > 20 THEN
    RAISE EXCEPTION 'A pattern can have at most 20 subject sections';
  END IF;

  FOR section IN SELECT value FROM jsonb_array_elements(sections_param) LOOP
    IF jsonb_typeof(section) <> 'object' THEN
      RAISE EXCEPTION 'Each pattern section must name a subject and a question count';
    END IF;
    SELECT * INTO subject_row FROM public.subjects AS s
    WHERE lower(s.name) = lower(btrim(COALESCE(section->>'subject', '')));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown subject "%" in pattern', COALESCE(section->>'subject', '');
    END IF;
    IF NOT subject_row.is_active THEN
      RAISE EXCEPTION 'Subject "%" is inactive. Reactivate it or remove it from the pattern.', subject_row.name;
    END IF;
    IF lower(subject_row.name) = ANY(seen) THEN
      RAISE EXCEPTION 'Subject "%" appears more than once in the pattern', subject_row.name;
    END IF;
    seen := array_append(seen, lower(subject_row.name));

    IF COALESCE(section->>'questionCount', '') !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Question count for "%" must be a whole number', subject_row.name;
    END IF;
    question_count := (section->>'questionCount')::integer;
    IF question_count NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'Question count for "%" must be between 1 and 500', subject_row.name;
    END IF;
    total := total + question_count;
    normalized := normalized || jsonb_build_array(
      jsonb_build_object('subject', subject_row.name, 'questionCount', question_count)
    );
  END LOOP;

  IF total > 500 THEN
    RAISE EXCEPTION 'A pattern can contain at most 500 questions in total (this one has %)', total;
  END IF;
  RETURN normalized;
END;
$function$;
REVOKE ALL ON FUNCTION public.normalize_exam_template_sections(jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.assert_subject_name(name_param text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $function$
DECLARE
  cleaned text := regexp_replace(btrim(COALESCE(name_param, '')), '\s+', ' ', 'g');
BEGIN
  IF length(cleaned) = 0 THEN RAISE EXCEPTION 'Enter a subject name'; END IF;
  IF length(cleaned) > 60 THEN RAISE EXCEPTION 'Subject names can be at most 60 characters'; END IF;
  IF cleaned !~ '^[[:alnum:]][[:alnum:] &().,/+''-]*$' THEN
    RAISE EXCEPTION 'Subject names may contain letters, numbers, spaces and & ( ) . , / + '' - only, and must start with a letter or number';
  END IF;
  RETURN cleaned;
END;
$function$;
REVOKE ALL ON FUNCTION public.assert_subject_name(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Administrator API: subjects
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.admin_list_subjects()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'displayOrder', s.display_order, 'isActive', s.is_active,
      'usage', public.subject_usage(s.name)
    ) ORDER BY s.display_order, lower(s.name))
    FROM public.subjects AS s
  ), '[]'::jsonb);
END;
$function$;

CREATE FUNCTION public.admin_save_subject(
  subject_id_param uuid,
  name_param text,
  is_active_param boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  cleaned_name text;
  existing public.subjects%ROWTYPE;
  usage jsonb;
  saved public.subjects%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  cleaned_name := public.assert_subject_name(name_param);
  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));

  IF EXISTS (SELECT 1 FROM public.subjects AS s
             WHERE lower(s.name) = lower(cleaned_name)
               AND s.id IS DISTINCT FROM subject_id_param) THEN
    RAISE EXCEPTION 'A subject named "%" already exists', cleaned_name;
  END IF;

  IF subject_id_param IS NULL THEN
    INSERT INTO public.subjects (name, display_order, is_active)
    VALUES (cleaned_name,
            COALESCE((SELECT max(s.display_order) + 1 FROM public.subjects AS s), 1),
            COALESCE(is_active_param, true))
    RETURNING * INTO saved;
    INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'CREATE_SUBJECT', 'subject', saved.id::text, jsonb_build_object('name', saved.name));
  ELSE
    SELECT * INTO existing FROM public.subjects AS s WHERE s.id = subject_id_param FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Subject not found'; END IF;
    usage := public.subject_usage(existing.name);

    -- Questions, patterns and immutable exam snapshots store the subject name, so a
    -- subject that is in use keeps its exact name (even letter case).
    IF cleaned_name IS DISTINCT FROM existing.name
       AND ((usage->>'questions')::integer > 0 OR (usage->>'templates')::integer > 0 OR (usage->>'exams')::integer > 0) THEN
      RAISE EXCEPTION 'Subject "%" is already used by % question(s), % pattern(s) and % exam(s), so it cannot be renamed. Create a new subject instead.',
        existing.name, usage->>'questions', usage->>'templates', usage->>'exams';
    END IF;

    IF COALESCE(is_active_param, true) = false AND existing.is_active
       AND (usage->>'activeTemplates')::integer > 0 THEN
      RAISE EXCEPTION 'Subject "%" is used by % active pattern(s). Remove it from those patterns or deactivate them first.',
        existing.name, usage->>'activeTemplates';
    END IF;

    UPDATE public.subjects AS s
    SET name = cleaned_name, is_active = COALESCE(is_active_param, true), updated_at = now()
    WHERE s.id = subject_id_param
    RETURNING * INTO saved;
    INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'UPDATE_SUBJECT', 'subject', saved.id::text,
            jsonb_build_object('name', saved.name, 'previous_name', existing.name, 'is_active', saved.is_active));
  END IF;

  RETURN jsonb_build_object('id', saved.id, 'name', saved.name, 'displayOrder', saved.display_order, 'isActive', saved.is_active);
END;
$function$;

CREATE FUNCTION public.admin_reorder_subjects(ordered_ids_param uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  expected integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));
  SELECT count(*) INTO expected FROM public.subjects;
  IF ordered_ids_param IS NULL
     OR cardinality(ordered_ids_param) <> expected
     OR (SELECT count(DISTINCT x) FROM unnest(ordered_ids_param) AS x) <> expected
     OR EXISTS (SELECT 1 FROM unnest(ordered_ids_param) AS x WHERE NOT EXISTS (SELECT 1 FROM public.subjects AS s WHERE s.id = x)) THEN
    RAISE EXCEPTION 'The subject list changed while you were reordering. Reload and try again.';
  END IF;
  UPDATE public.subjects AS s
  SET display_order = o.position, updated_at = now()
  FROM unnest(ordered_ids_param) WITH ORDINALITY AS o(id, position)
  WHERE s.id = o.id;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'REORDER_SUBJECTS', 'subject', NULL, jsonb_build_object('count', expected));
  RETURN jsonb_build_object('reordered', expected);
END;
$function$;

CREATE FUNCTION public.admin_delete_subject(subject_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  existing public.subjects%ROWTYPE;
  usage jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));
  SELECT * INTO existing FROM public.subjects AS s WHERE s.id = subject_id_param FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subject not found'; END IF;
  usage := public.subject_usage(existing.name);
  IF (usage->>'questions')::integer > 0 OR (usage->>'templates')::integer > 0 OR (usage->>'exams')::integer > 0 THEN
    RAISE EXCEPTION 'Subject "%" is used by % question(s), % pattern(s) and % exam(s), so it cannot be deleted. Deactivate it instead.',
      existing.name, usage->>'questions', usage->>'templates', usage->>'exams';
  END IF;
  IF (SELECT count(*) FROM public.subjects AS s WHERE s.is_active AND s.id <> existing.id) = 0 THEN
    RAISE EXCEPTION 'At least one active subject must remain';
  END IF;
  DELETE FROM public.subjects AS s WHERE s.id = existing.id;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DELETE_SUBJECT', 'subject', existing.id::text, jsonb_build_object('name', existing.name));
  RETURN jsonb_build_object('deleted', true);
END;
$function$;

-- ---------------------------------------------------------------------------
-- Administrator API: exam patterns (templates)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.admin_list_exam_templates()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'description', t.description,
      'durationMinutes', t.duration_minutes,
      'marksCorrect', t.marks_correct, 'marksIncorrect', t.marks_incorrect,
      'sections', t.sections, 'isActive', t.is_active,
      'totalQuestions', (SELECT COALESCE(sum((s->>'questionCount')::integer), 0) FROM jsonb_array_elements(t.sections) AS s),
      'inactiveSubjects', (
        SELECT COALESCE(jsonb_agg(s->>'subject'), '[]'::jsonb)
        FROM jsonb_array_elements(t.sections) AS s
        WHERE NOT EXISTS (SELECT 1 FROM public.subjects AS sub
                          WHERE lower(sub.name) = lower(s->>'subject') AND sub.is_active)
      ),
      'updatedAt', t.updated_at
    ) ORDER BY lower(t.name))
    FROM public.exam_templates AS t
  ), '[]'::jsonb);
END;
$function$;

CREATE FUNCTION public.admin_save_exam_template(
  template_id_param uuid,
  name_param text,
  description_param text,
  duration_minutes_param integer,
  marks_correct_param numeric,
  marks_incorrect_param numeric,
  sections_param jsonb,
  is_active_param boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  cleaned_name text := regexp_replace(btrim(COALESCE(name_param, '')), '\s+', ' ', 'g');
  cleaned_description text := btrim(COALESCE(description_param, ''));
  normalized_sections jsonb;
  saved public.exam_templates%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  IF length(cleaned_name) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Pattern name must be between 1 and 80 characters'; END IF;
  IF length(cleaned_description) > 500 THEN RAISE EXCEPTION 'Description can be at most 500 characters'; END IF;
  IF duration_minutes_param IS NULL OR duration_minutes_param NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Duration must be between 1 and 600 minutes';
  END IF;
  IF marks_correct_param IS NULL OR marks_correct_param <= 0 OR marks_correct_param > 100 THEN
    RAISE EXCEPTION 'Marks for a correct answer must be greater than 0 and at most 100';
  END IF;
  IF marks_incorrect_param IS NULL OR marks_incorrect_param NOT BETWEEN -100 AND 0 THEN
    RAISE EXCEPTION 'Marks for a wrong answer must be between -100 and 0';
  END IF;
  IF round(marks_correct_param, 2) <> marks_correct_param OR round(marks_incorrect_param, 2) <> marks_incorrect_param THEN
    RAISE EXCEPTION 'Marks can have at most two decimal places';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));
  normalized_sections := public.normalize_exam_template_sections(sections_param);

  IF EXISTS (SELECT 1 FROM public.exam_templates AS t
             WHERE lower(t.name) = lower(cleaned_name) AND t.id IS DISTINCT FROM template_id_param) THEN
    RAISE EXCEPTION 'A pattern named "%" already exists', cleaned_name;
  END IF;

  IF template_id_param IS NULL THEN
    INSERT INTO public.exam_templates (name, description, duration_minutes, marks_correct, marks_incorrect, sections, is_active)
    VALUES (cleaned_name, cleaned_description, duration_minutes_param, marks_correct_param, marks_incorrect_param,
            normalized_sections, COALESCE(is_active_param, true))
    RETURNING * INTO saved;
  ELSE
    UPDATE public.exam_templates AS t
    SET name = cleaned_name, description = cleaned_description, duration_minutes = duration_minutes_param,
        marks_correct = marks_correct_param, marks_incorrect = marks_incorrect_param,
        sections = normalized_sections, is_active = COALESCE(is_active_param, true), updated_at = now()
    WHERE t.id = template_id_param
    RETURNING * INTO saved;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pattern not found'; END IF;
  END IF;

  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), CASE WHEN template_id_param IS NULL THEN 'CREATE_EXAM_TEMPLATE' ELSE 'UPDATE_EXAM_TEMPLATE' END,
          'exam_template', saved.id::text,
          jsonb_build_object('name', saved.name, 'sections', jsonb_array_length(saved.sections), 'is_active', saved.is_active));
  RETURN jsonb_build_object('id', saved.id, 'name', saved.name);
END;
$function$;

CREATE FUNCTION public.admin_delete_exam_template(template_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  existing public.exam_templates%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  DELETE FROM public.exam_templates AS t WHERE t.id = template_id_param RETURNING * INTO existing;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pattern not found'; END IF;
  -- Exams created from this pattern keep their own copy of its structure.
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DELETE_EXAM_TEMPLATE', 'exam_template', existing.id::text, jsonb_build_object('name', existing.name));
  RETURN jsonb_build_object('deleted', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_list_subjects() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_save_subject(uuid, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reorder_subjects(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_subject(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_exam_templates() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_save_exam_template(uuid, text, text, integer, numeric, numeric, jsonb, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_exam_template(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_subjects() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_subject(uuid, text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reorder_subjects(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_subject(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_exam_templates() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_exam_template(uuid, text, text, integer, numeric, numeric, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_exam_template(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Existing validators now read the subjects table (definitions below are the
-- previous ones with only the subject checks changed).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.preflight_validate_exam(exam_id_param uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  private_answers jsonb;
  reconstructed_data jsonb;
  errors text[] := ARRAY[]::text[];
  warnings text[] := ARRAY[]::text[];
  seen_question_ids text[] := ARRAY[]::text[];
  declared_subjects text[] := ARRAY[]::text[];
  subject_name text;
  question_item jsonb;
  question_id text;
  question_image text;
  option_image text;
  answer_item jsonb;
  answer_question_id text;
  total_questions integer := 0;
  verified_assets integer := 0;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam not found'; END IF;

  IF exam_row.class IS NULL OR length(btrim(exam_row.class)) = 0 THEN
    errors := array_append(errors, 'Target class is required');
  ELSIF exam_row.class <> 'All'
    AND NOT EXISTS (SELECT 1 FROM public.classes WHERE name = exam_row.class) THEN
    errors := array_append(errors, format('Target class "%s" does not exist', exam_row.class));
  END IF;
  IF exam_row.section IS NULL OR length(btrim(exam_row.section)) = 0 THEN
    errors := array_append(errors, 'Target section is required');
  ELSIF exam_row.class <> 'All' AND exam_row.section <> 'All'
    AND NOT EXISTS (
      SELECT 1 FROM public.classes
      WHERE name = exam_row.class AND exam_row.section = ANY(sections)
    ) THEN
    errors := array_append(errors, format('Target section "%s" is not registered under class "%s"', exam_row.section, exam_row.class));
  END IF;

  SELECT answers INTO private_answers FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  IF private_answers IS NULL OR jsonb_typeof(private_answers) <> 'object' THEN
    errors := array_append(errors, 'Private answer key is missing or invalid');
    private_answers := '{}'::jsonb;
  END IF;

  reconstructed_data := public.reconstruct_exam_questions(exam_row.questions_data, private_answers);
  BEGIN
    PERFORM public.validate_full_exam_paper(exam_row.title, reconstructed_data);
  EXCEPTION WHEN OTHERS THEN
    errors := array_append(errors, SQLERRM);
  END;

  IF jsonb_typeof(exam_row.questions_data->'subjects') = 'array' THEN
    FOR subject_name IN SELECT jsonb_array_elements_text(exam_row.questions_data->'subjects') LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.subjects AS configured
        WHERE lower(configured.name) = lower(btrim(subject_name))
      ) THEN
        errors := array_append(errors, format('Unknown subject "%s". Add it under Subjects & Patterns first.', subject_name));
      END IF;
      IF lower(btrim(subject_name)) = ANY(declared_subjects) THEN
        errors := array_append(errors, format('Duplicate subject "%s"', subject_name));
      ELSE
        declared_subjects := array_append(declared_subjects, lower(btrim(subject_name)));
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(exam_row.questions_data->'questions') = 'object' THEN
    FOR subject_name IN SELECT jsonb_object_keys(exam_row.questions_data->'questions') LOOP
      IF NOT (lower(btrim(subject_name)) = ANY(declared_subjects)) THEN
        errors := array_append(errors, format('Questions contain undeclared subject "%s"', subject_name));
      END IF;
      IF jsonb_typeof(exam_row.questions_data->'questions'->subject_name) <> 'array' THEN
        errors := array_append(errors, format('Questions for subject "%s" must be an array', subject_name));
        CONTINUE;
      END IF;

      FOR question_item IN SELECT value FROM jsonb_array_elements(exam_row.questions_data->'questions'->subject_name) LOOP
        total_questions := total_questions + 1;
        question_id := btrim(COALESCE(question_item->>'id', ''));
        IF question_id = '' THEN
          errors := array_append(errors, format('Question %s in %s has no stable ID', total_questions, subject_name));
        ELSIF question_id = ANY(seen_question_ids) THEN
          errors := array_append(errors, format('Duplicate question ID "%s"', question_id));
        ELSE
          seen_question_ids := array_append(seen_question_ids, question_id);
        END IF;

        IF question_item ? 'correctAnswer' OR question_item ? 'correct_answer' THEN
          errors := array_append(errors, format('Question "%s" exposes its answer in public exam data', COALESCE(NULLIF(question_id, ''), total_questions::text)));
        END IF;

        answer_item := private_answers->question_id;
        IF question_id <> '' AND answer_item IS NULL THEN
          errors := array_append(errors, format('Question "%s" has no private answer-key entry', question_id));
        ELSIF answer_item IS NOT NULL AND (
          answer_item->>'subject' IS DISTINCT FROM subject_name
          OR upper(COALESCE(answer_item->>'type', '')) IS DISTINCT FROM upper(COALESCE(question_item->>'type', 'MCQ'))
        ) THEN
          errors := array_append(errors, format('Question "%s" answer metadata does not match the public paper', question_id));
        END IF;

        question_image := btrim(COALESCE(question_item->>'questionImageUrl', question_item->>'imageUrl', ''));
        IF question_image <> '' THEN
          IF question_image ~* '^https?://' OR question_image ~* '^data:' THEN
            errors := array_append(errors, format('Question "%s" must use a private exam-assets path, not an external or embedded image', question_id));
          ELSIF NOT EXISTS (
            SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = question_image
          ) THEN
            errors := array_append(errors, format('Question "%s" references missing storage asset: "%s"', question_id, question_image));
          ELSE
            verified_assets := verified_assets + 1;
          END IF;
        END IF;

        IF jsonb_typeof(question_item->'optionImageUrls') = 'array' THEN
          FOR option_index IN 0..jsonb_array_length(question_item->'optionImageUrls') - 1 LOOP
            option_image := btrim(COALESCE(question_item->'optionImageUrls'->>option_index, ''));
            IF option_image = '' OR lower(option_image) = 'null' THEN CONTINUE; END IF;
            IF option_image ~* '^https?://' OR option_image ~* '^data:' THEN
              errors := array_append(errors, format('Question "%s" option %s must use a private exam-assets path', question_id, option_index + 1));
            ELSIF NOT EXISTS (
              SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = option_image
            ) THEN
              errors := array_append(errors, format('Question "%s" option %s references missing storage asset: "%s"', question_id, option_index + 1, option_image));
            ELSE
              verified_assets := verified_assets + 1;
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  FOR answer_question_id IN SELECT jsonb_object_keys(private_answers) LOOP
    IF NOT (answer_question_id = ANY(seen_question_ids)) THEN
      errors := array_append(errors, format('Private answer key contains unknown question ID "%s"', answer_question_id));
    END IF;
  END LOOP;

  IF total_questions = 0 THEN errors := array_append(errors, 'The exam paper has zero questions'); END IF;

  RETURN jsonb_build_object(
    'valid', cardinality(errors) = 0,
    'errors', to_jsonb(errors),
    'warnings', to_jsonb(warnings),
    'totalQuestions', total_questions,
    'verifiedAssets', verified_assets
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_question_bank_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  option_index integer;
  option_text text;
  option_image text;
  option_key text;
  seen_keys text[] := ARRAY[]::text[];
  canonical_subject text;
BEGIN
  NEW.subject := btrim(NEW.subject);
  NEW.type := upper(NEW.type);
  NEW.question_text := btrim(NEW.question_text);
  NEW.correct_answer := btrim(NEW.correct_answer);

  -- Subjects are administrator-configured. New questions, and questions moved to
  -- another subject, must use an active subject; existing questions keep working
  -- after their subject is deactivated.
  IF TG_OP = 'INSERT' OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    canonical_subject := public.resolve_active_subject(NEW.subject);
    IF canonical_subject IS NULL THEN
      RAISE EXCEPTION 'Question subject "%" is not an active subject. Add or reactivate it under Subjects & Patterns.', NEW.subject;
    END IF;
    NEW.subject := canonical_subject;
  END IF;
  IF NEW.type NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN RAISE EXCEPTION 'Question type is invalid'; END IF;
  IF length(NEW.question_text) > 10000 THEN RAISE EXCEPTION 'Question text must not exceed 10000 characters'; END IF;
  IF NEW.question_text = '' AND length(btrim(COALESCE(NEW.question_image_url, ''))) = 0 THEN
    RAISE EXCEPTION 'Question text or a question image is required';
  END IF;
  IF NEW.question_image_url IS NOT NULL AND length(NEW.question_image_url) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'Question image reference is invalid';
  END IF;

  IF NEW.type = 'MCQ' THEN
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 4
       OR NEW.correct_answer !~ '^[0-3]$' THEN
      RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
    END IF;
    IF NEW.option_image_urls IS NOT NULL
       AND (jsonb_typeof(NEW.option_image_urls) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.option_image_urls) <> 4) THEN
      RAISE EXCEPTION 'MCQ option image references must contain exactly four positions';
    END IF;
    FOR option_index IN 0..3 LOOP
      IF jsonb_typeof(NEW.options->option_index) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Every MCQ option text value must be a string';
      END IF;
      option_text := btrim(COALESCE(NEW.options->>option_index, ''));
      option_image := btrim(COALESCE(NEW.option_image_urls->>option_index, ''));
      IF length(option_text) > 5000 THEN RAISE EXCEPTION 'MCQ option text must not exceed 5000 characters'; END IF;
      IF length(option_image) > 2048 THEN RAISE EXCEPTION 'MCQ option image reference is too long'; END IF;
      IF option_text = '' AND option_image = '' THEN RAISE EXCEPTION 'Every MCQ option requires text or an image'; END IF;
      option_key := CASE WHEN option_image <> '' THEN 'img:' || option_image ELSE 'text:' || public.canonical_question_text(option_text) END;
      IF option_key = ANY(seen_keys) THEN RAISE EXCEPTION 'MCQ options must be unique'; END IF;
      seen_keys := array_append(seen_keys, option_key);
    END LOOP;
  ELSE
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 0
       OR length(NEW.correct_answer) NOT BETWEEN 1 AND 100
       OR NEW.correct_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
      RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
    END IF;
    IF NEW.option_image_urls IS NOT NULL AND NEW.option_image_urls <> '[]'::jsonb
       AND NEW.option_image_urls <> '[null, null, null, null]'::jsonb THEN
      RAISE EXCEPTION 'Numerical questions cannot retain option images';
    END IF;
    NEW.option_image_urls := '[]'::jsonb;
  END IF;
  NEW.has_image_or_diagram := COALESCE(NEW.has_image_or_diagram, false) OR NEW.question_image_url IS NOT NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_import_questions(batch_id_param uuid, file_name_param text, questions_param jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  item jsonb;
  option_value jsonb;
  item_type text;
  item_subject text;
  item_text text;
  item_answer text;
  item_options jsonb;
  item_count integer;
  request_hash text;
  existing_batch public.question_import_batches%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF batch_id_param IS NULL THEN RAISE EXCEPTION 'Import batch ID is required'; END IF;
  IF length(btrim(COALESCE(file_name_param, ''))) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'File name must contain between 1 and 255 characters';
  END IF;
  IF jsonb_typeof(questions_param) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Questions payload must be a JSON array';
  END IF;
  item_count := jsonb_array_length(questions_param);
  IF item_count NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Import must contain between 1 and 500 questions'; END IF;
  IF octet_length(convert_to(questions_param::text, 'UTF8')) > 5242880 THEN
    RAISE EXCEPTION 'Import payload must not exceed 5 MB';
  END IF;

  request_hash := md5(questions_param::text);
  LOCK TABLE public.question_import_batches IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO existing_batch FROM public.question_import_batches WHERE batch_id = batch_id_param;
  IF FOUND THEN
    IF existing_batch.imported_by IS DISTINCT FROM actor_id OR existing_batch.payload_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Import batch ID was already used for a different request';
    END IF;
    RETURN jsonb_build_object('imported', existing_batch.question_count, 'idempotent', true, 'batch_id', batch_id_param);
  END IF;

  LOCK TABLE public.question_bank IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('cbt.question_import_batch', 'on', true);
  FOR item IN SELECT value FROM jsonb_array_elements(questions_param) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Every question must be a JSON object'; END IF;
    IF (item - ARRAY['subject','type','question_text','options','correct_answer','has_image_or_diagram','category','points','neg_points']::text[]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Question contains unsupported fields';
    END IF;
    item_type := item->>'type';
    item_subject := item->>'subject';
    item_text := btrim(COALESCE(item->>'question_text', ''));
    item_answer := btrim(COALESCE(item->>'correct_answer', ''));
    item_options := item->'options';

    SELECT configured.name INTO item_subject
    FROM public.subjects AS configured
    WHERE lower(configured.name) = lower(btrim(COALESCE(item->>'subject', ''))) AND configured.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid question subject'; END IF;
    IF item_type NOT IN ('MCQ', 'NUMERICAL') THEN RAISE EXCEPTION 'Invalid question type'; END IF;
    IF length(item_text) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Question text must contain between 1 and 10000 characters'; END IF;
    IF jsonb_typeof(item->'has_image_or_diagram') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Image indicator must be boolean'; END IF;
    IF COALESCE((item->>'points')::integer, 0) <> 4 OR COALESCE((item->>'neg_points')::integer, 0) <> -1 THEN
      RAISE EXCEPTION 'Imported JEE questions must use +4/-1 scoring';
    END IF;

    IF item_type = 'MCQ' THEN
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 4 OR item_answer !~ '^[0-3]$' THEN
        RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
      END IF;
      FOR option_value IN SELECT value FROM jsonb_array_elements(item_options) LOOP
        IF jsonb_typeof(option_value) IS DISTINCT FROM 'string'
           OR length(btrim(option_value #>> '{}')) NOT BETWEEN 1 AND 5000 THEN
          RAISE EXCEPTION 'Every MCQ option must contain between 1 and 5000 characters';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT public.canonical_question_text(value #>> '{}')) FROM jsonb_array_elements(item_options)) <> 4 THEN
        RAISE EXCEPTION 'MCQ options must be unique';
      END IF;
    ELSE
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 0
         OR length(item_answer) NOT BETWEEN 1 AND 100
         OR item_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
        RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.question_bank WHERE public.canonical_question_text(question_text) = public.canonical_question_text(item_text)) THEN
      RAISE EXCEPTION 'A matching question already exists in the Question Bank';
    END IF;

    INSERT INTO public.question_bank (
      subject, type, question_text, options, correct_answer, has_image_or_diagram, category, points, neg_points
    ) VALUES (
      item_subject, item_type, item_text, item_options, item_answer,
      (item->>'has_image_or_diagram')::boolean, COALESCE(NULLIF(btrim(item->>'category'), ''), 'Mains'), 4, -1
    );
  END LOOP;

  INSERT INTO public.question_import_batches (batch_id, imported_by, payload_hash, file_name, question_count)
  VALUES (batch_id_param, actor_id, request_hash, btrim(file_name_param), item_count);
  INSERT INTO public.import_history (file_name, total_questions, successful_imports, rejected_questions, status)
  VALUES (btrim(file_name_param), item_count, item_count, 0, 'Success');
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (actor_id, 'IMPORT_QUESTIONS', 'question_import_batch', batch_id_param::text,
          jsonb_build_object('file_name', btrim(file_name_param), 'question_count', item_count));

  RETURN jsonb_build_object('imported', item_count, 'idempotent', false, 'batch_id', batch_id_param);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_question_bank_page(page_number_param integer, page_size_param integer, search_param text DEFAULT NULL::text, subject_param text DEFAULT NULL::text, type_param text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  normalized_subject text := NULLIF(btrim(COALESCE(subject_param, '')), '');
  normalized_type text := NULLIF(upper(btrim(COALESCE(type_param, ''))), '');
  total_count integer;
  page_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 200';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Question search must not exceed 100 characters';
  END IF;
  IF normalized_subject IS NOT NULL AND length(normalized_subject) > 100 THEN
    RAISE EXCEPTION 'Subject filter must not exceed 100 characters';
  END IF;
  IF normalized_type IS NOT NULL AND normalized_type NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
    RAISE EXCEPTION 'Question type filter is invalid';
  END IF;

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  )
  SELECT count(*)::integer INTO total_count
  FROM numbered question
  WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
    AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE 'MCQ' END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)
    AND (
      normalized_search IS NULL
      OR position(lower(normalized_search) in lower(question.question_text)) > 0
      OR position(lower(normalized_search) in lower(question.subject)) > 0
      OR position(normalized_search in question.question_number::text) > 0
    );

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  ), filtered AS (
    SELECT question.*,
      COALESCE((
        SELECT configured.display_order FROM public.subjects AS configured
        WHERE lower(configured.name) = lower(question.subject)
      ), 1000000) AS subject_sort
    FROM numbered question
    WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
      AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE 'MCQ' END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)
      AND (
        normalized_search IS NULL
        OR position(lower(normalized_search) in lower(question.question_text)) > 0
        OR position(lower(normalized_search) in lower(question.subject)) > 0
        OR position(normalized_search in question.question_number::text) > 0
      )
  )
  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.subject_sort, page_row.subject, page_row.question_number, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT question.subject_sort, question.subject, question.question_number, question.id,
      jsonb_build_object(
        'id', question.id,
        'subject', question.subject,
        'type', question.type,
        'question_number', question.question_number,
        'question_text', question.question_text,
        'options', question.options,
        'correct_answer', question.correct_answer,
        'question_image_url', question.question_image_url,
        'option_image_urls', question.option_image_urls,
        'has_image_or_diagram', question.has_image_or_diagram,
        'created_at', question.created_at
      ) AS payload
    FROM filtered question
    ORDER BY question.subject_sort, question.subject, question.question_number, question.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object('page', page_number_param, 'page_size', page_size_param, 'total', total_count, 'rows', page_rows);
END;
$function$;

COMMIT;
