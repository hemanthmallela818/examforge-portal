-- #8: make the exam hot path cheap at 100–300 concurrent candidates.
--
-- Every autosave and subject-time sync used to load the candidate's whole
-- shuffled paper (active_sessions.jumbled_exam_data, often hundreds of KB) just
-- to read each question's type and option count, the subject list and the
-- duration. This migration stores that compact structure in
-- active_sessions.response_schema (kept in step by a trigger) and makes both
-- functions read only the small columns. Validation rules are unchanged:
-- sanitize_exam_responses receives the same shape (type + options array of the
-- same length, with option contents replaced by null).

BEGIN;

ALTER TABLE public.active_sessions ADD COLUMN IF NOT EXISTS response_schema jsonb;

CREATE OR REPLACE FUNCTION public.build_session_response_schema(paper_param jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'subjects', COALESCE(paper_param -> 'subjects', '[]'::pg_catalog.jsonb),
    'duration', paper_param -> 'duration',
    'questions', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(
        subject.key,
        CASE WHEN pg_catalog.jsonb_typeof(subject.value) OPERATOR(pg_catalog.=) 'array' THEN (
          SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'type', question.item -> 'type',
              'options', CASE WHEN pg_catalog.jsonb_typeof(question.item -> 'options') OPERATOR(pg_catalog.=) 'array' THEN (
                SELECT COALESCE(pg_catalog.jsonb_agg('null'::pg_catalog.jsonb), '[]'::pg_catalog.jsonb)
                FROM pg_catalog.jsonb_array_elements(question.item -> 'options')
              ) ELSE question.item -> 'options' END
            ) ORDER BY question.position
          ), '[]'::pg_catalog.jsonb)
          FROM pg_catalog.jsonb_array_elements(subject.value) WITH ORDINALITY AS question(item, position)
        ) ELSE subject.value END
      )
      FROM pg_catalog.jsonb_each(paper_param -> 'questions') AS subject
      WHERE pg_catalog.jsonb_typeof(paper_param -> 'questions') OPERATOR(pg_catalog.=) 'object'
    ), '{}'::pg_catalog.jsonb)
  );
$function$;
REVOKE ALL ON FUNCTION public.build_session_response_schema(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_session_response_schema()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.response_schema := public.build_session_response_schema(NEW.jumbled_exam_data);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.set_session_response_schema() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS set_session_response_schema_trigger ON public.active_sessions;
CREATE TRIGGER set_session_response_schema_trigger
BEFORE INSERT OR UPDATE OF jumbled_exam_data ON public.active_sessions
FOR EACH ROW EXECUTE FUNCTION public.set_session_response_schema();

-- Backfill attempts that are already in progress.
UPDATE public.active_sessions
SET response_schema = public.build_session_response_schema(jumbled_exam_data)
WHERE response_schema IS NULL;

CREATE OR REPLACE FUNCTION public.sync_active_session_progress_stage3_internal(exam_id_param uuid, responses_param jsonb, expected_version_param integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_id pg_catalog.text;
  canonical_responses pg_catalog.jsonb;
  new_version pg_catalog.int4;
BEGIN
  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;
  IF expected_version_param IS NULL OR expected_version_param OPERATOR(pg_catalog.<) 1 THEN
    RAISE EXCEPTION 'A positive expected session version is required';
  END IF;

  session_id := student_row.id::pg_catalog.text
    OPERATOR(pg_catalog.||) '_'
    OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  -- Read only the small columns. The full shuffled paper (jumbled_exam_data)
  -- stays in TOAST storage; its compact response_schema is enough to validate.
  SELECT s.id, s.version, s.deadline_at, s.response_schema
  INTO session_row.id, session_row.version, session_row.deadline_at, session_row.response_schema
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted';
  END IF;

  IF expected_version_param OPERATOR(pg_catalog.<>) session_row.version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'user_responses', (
        SELECT s.user_responses FROM public.active_sessions AS s
        WHERE s.id OPERATOR(pg_catalog.=) session_id
      )
    );
  END IF;
  IF session_row.deadline_at IS NULL
    OR pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
  THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved';
  END IF;

  canonical_responses := public.sanitize_exam_responses(
    responses_param,
    COALESCE(
      session_row.response_schema -> 'questions',
      (SELECT s.jumbled_exam_data -> 'questions' FROM public.active_sessions AS s
       WHERE s.id OPERATOR(pg_catalog.=) session_id)
    )
  );
  new_version := session_row.version OPERATOR(pg_catalog.+) 1;
  UPDATE public.active_sessions AS s
  SET user_responses = canonical_responses,
      updated_at = pg_catalog.clock_timestamp(),
      version = new_version
  WHERE s.id OPERATOR(pg_catalog.=) session_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'conflict', false,
    'version', new_version,
    'saved_at', pg_catalog.clock_timestamp()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_exam_subject_time(exam_id_param uuid, subject_time_seconds_param jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_subjects pg_catalog.jsonb;
  session_duration pg_catalog.int4;
  subject_entry pg_catalog.record;
  merged_time pg_catalog.jsonb;
  submitted_seconds pg_catalog.int4;
  previous_seconds pg_catalog.int4;
  submitted_total pg_catalog.int8 := 0;
  elapsed_limit pg_catalog.int8;
BEGIN
  PERFORM public.assert_current_student_session();

  IF exam_id_param IS NULL
    OR subject_time_seconds_param IS NULL
    OR pg_catalog.jsonb_typeof(subject_time_seconds_param) OPERATOR(pg_catalog.<>) 'object'
    OR pg_catalog.octet_length(subject_time_seconds_param::pg_catalog.text) OPERATOR(pg_catalog.>) 4096
  THEN
    RAISE EXCEPTION 'Invalid subject timing payload';
  END IF;

  SELECT student.* INTO student_row
  FROM public.students AS student
  WHERE student.id OPERATOR(pg_catalog.=) auth.uid()
    AND student.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active student profile not found'; END IF;

  -- Only the small columns; subjects and duration come from response_schema.
  SELECT session.id, session.subject_time_seconds, session.started_at,
         COALESCE(session.response_schema -> 'subjects', session.jumbled_exam_data -> 'subjects'),
         COALESCE((session.response_schema ->> 'duration'), (session.jumbled_exam_data ->> 'duration'))::pg_catalog.int4
  INTO session_row.id, session_row.subject_time_seconds, session_row.started_at, session_subjects, session_duration
  FROM public.active_sessions AS session
  WHERE session.id OPERATOR(pg_catalog.=) (
    student_row.id::pg_catalog.text OPERATOR(pg_catalog.||) '_'
      OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text
  )
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active exam session not found'; END IF;

  merged_time := COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb);
  FOR subject_entry IN
    SELECT entry.key, entry.value
    FROM pg_catalog.jsonb_each(subject_time_seconds_param) AS entry
  LOOP
    IF NOT COALESCE(session_subjects, '[]'::pg_catalog.jsonb)
      OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_array(subject_entry.key)
    THEN
      RAISE EXCEPTION 'Unknown examination subject';
    END IF;
    IF pg_catalog.jsonb_typeof(subject_entry.value) OPERATOR(pg_catalog.<>) 'number'
      OR subject_entry.value::pg_catalog.text !~ '^[0-9]+$'
    THEN
      RAISE EXCEPTION 'Subject time values must be whole non-negative seconds';
    END IF;
    submitted_seconds := subject_entry.value::pg_catalog.text::pg_catalog.int4;
    previous_seconds := COALESCE((merged_time ->> subject_entry.key)::pg_catalog.int4, 0);
    IF submitted_seconds OPERATOR(pg_catalog.<) previous_seconds THEN
      RAISE EXCEPTION 'Subject time cannot move backwards';
    END IF;
    submitted_total := submitted_total OPERATOR(pg_catalog.+) submitted_seconds;
    merged_time := pg_catalog.jsonb_set(
      merged_time,
      ARRAY[subject_entry.key],
      pg_catalog.to_jsonb(submitted_seconds),
      true
    );
  END LOOP;

  elapsed_limit := LEAST(
    GREATEST(COALESCE(session_duration, 180), 1) * 60,
    GREATEST(pg_catalog.floor(EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - session_row.started_at)))::pg_catalog.int8, 0)
  ) OPERATOR(pg_catalog.+) 15;
  IF submitted_total OPERATOR(pg_catalog.>) elapsed_limit THEN
    RAISE EXCEPTION 'Subject timing exceeds the elapsed examination time';
  END IF;

  UPDATE public.active_sessions AS session
  SET subject_time_seconds = merged_time
  WHERE session.id OPERATOR(pg_catalog.=) session_row.id;

  RETURN merged_time;
END;
$function$;

COMMIT;
