-- Stage 27: reliable administrator result access, private answer reviews,
-- subject timing, and clearer administrator authorization failures.

BEGIN;

-- The paged result function performs its own administrator check. It must run
-- with its owner's narrowly-scoped read authority because result tables are
-- intentionally hidden by RLS from ordinary authenticated users.
ALTER FUNCTION public.get_admin_exam_results_page(
  pg_catalog.uuid,
  pg_catalog.int4,
  pg_catalog.int4,
  pg_catalog.text,
  pg_catalog.int4
) SECURITY DEFINER;

ALTER TABLE public.active_sessions
  ADD COLUMN IF NOT EXISTS subject_time_seconds pg_catalog.jsonb
  NOT NULL DEFAULT '{}'::pg_catalog.jsonb;

ALTER TABLE public.active_sessions
  DROP CONSTRAINT IF EXISTS active_sessions_subject_time_object;
ALTER TABLE public.active_sessions
  ADD CONSTRAINT active_sessions_subject_time_object
  CHECK (pg_catalog.jsonb_typeof(subject_time_seconds) OPERATOR(pg_catalog.=) 'object');

-- This table deliberately has no authenticated policies or grants. It stores
-- only the submitted response snapshot and timings. The existing immutable exam
-- paper and private answer key are joined only while an administrator opens the
-- audited review RPC; sensitive keys are never duplicated here.
CREATE TABLE IF NOT EXISTS public.student_result_reviews (
  result_id pg_catalog.uuid PRIMARY KEY
    REFERENCES public.student_results(id) ON DELETE CASCADE,
  exam_id pg_catalog.uuid NOT NULL,
  student_id pg_catalog.text NOT NULL,
  response_snapshot pg_catalog.jsonb NOT NULL,
  subject_time_seconds pg_catalog.jsonb NOT NULL DEFAULT '{}'::pg_catalog.jsonb,
  created_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT student_result_reviews_response_object
    CHECK (pg_catalog.jsonb_typeof(response_snapshot) OPERATOR(pg_catalog.=) 'object'),
  CONSTRAINT student_result_reviews_time_object
    CHECK (pg_catalog.jsonb_typeof(subject_time_seconds) OPERATOR(pg_catalog.=) 'object')
);

ALTER TABLE public.student_result_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.student_result_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.student_result_reviews TO service_role;

CREATE INDEX IF NOT EXISTS student_result_reviews_exam_student_idx
  ON public.student_result_reviews (exam_id, student_id);

CREATE OR REPLACE FUNCTION public.capture_student_result_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  session_row public.active_sessions%ROWTYPE;
BEGIN
  SELECT session.*
  INTO session_row
  FROM public.active_sessions AS session
  WHERE session.exam_id OPERATOR(pg_catalog.=) NEW.exam_id
    AND session.student_id OPERATOR(pg_catalog.=) NEW.student_id
  ORDER BY session.updated_at DESC NULLS LAST
  LIMIT 1;

  IF session_row.id IS NOT NULL THEN
    INSERT INTO public.student_result_reviews (
      result_id,
      exam_id,
      student_id,
      response_snapshot,
      subject_time_seconds
    ) VALUES (
      NEW.id,
      NEW.exam_id::pg_catalog.uuid,
      NEW.student_id,
      COALESCE(session_row.user_responses, '{}'::pg_catalog.jsonb),
      COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb)
    )
    ON CONFLICT (result_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_student_result_review() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_student_result_review() TO service_role;

DROP TRIGGER IF EXISTS capture_student_result_review_after_insert ON public.student_results;
CREATE TRIGGER capture_student_result_review_after_insert
AFTER INSERT ON public.student_results
FOR EACH ROW EXECUTE FUNCTION public.capture_student_result_review();

CREATE OR REPLACE FUNCTION public.sync_exam_subject_time(
  exam_id_param pg_catalog.uuid,
  subject_time_seconds_param pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
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

  SELECT session.* INTO session_row
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
    IF NOT COALESCE(session_row.jumbled_exam_data -> 'subjects', '[]'::pg_catalog.jsonb)
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
    GREATEST(COALESCE((session_row.jumbled_exam_data ->> 'duration')::pg_catalog.int4, 180), 1) * 60,
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

REVOKE ALL ON FUNCTION public.sync_exam_subject_time(pg_catalog.uuid, pg_catalog.jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_exam_subject_time(pg_catalog.uuid, pg_catalog.jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_admin_student_result_review(
  result_id_param pg_catalog.uuid
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  review_row public.student_result_reviews%ROWTYPE;
  exam_paper pg_catalog.jsonb;
  answer_keys pg_catalog.jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Active administrator access is required';
  END IF;
  IF result_id_param IS NULL THEN RAISE EXCEPTION 'Result ID is required'; END IF;

  SELECT review.* INTO review_row
  FROM public.student_result_reviews AS review
  WHERE review.result_id OPERATOR(pg_catalog.=) result_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Detailed answer review is unavailable for this submission';
  END IF;

  SELECT exam.questions_data, answer.answers
  INTO exam_paper, answer_keys
  FROM public.cbt_exams_raw AS exam
  JOIN public.cbt_exam_answers AS answer
    ON answer.exam_id OPERATOR(pg_catalog.=) exam.id
  WHERE exam.id OPERATOR(pg_catalog.=) review_row.exam_id;
  IF NOT FOUND OR exam_paper IS NULL OR answer_keys IS NULL THEN
    RAISE EXCEPTION 'The immutable exam paper or answer key is unavailable';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    target_type,
    target_id,
    metadata
  ) VALUES (
    auth.uid(),
    'VIEW_STUDENT_ANSWER_REVIEW',
    'student_result',
    result_id_param::pg_catalog.text,
    pg_catalog.jsonb_build_object('exam_id', review_row.exam_id, 'student_id', review_row.student_id)
  );

  RETURN pg_catalog.jsonb_build_object(
    'result_id', review_row.result_id,
    'exam_id', review_row.exam_id,
    'student_id', review_row.student_id,
    'responses', review_row.response_snapshot,
    'paper', exam_paper,
    'answer_key', answer_keys,
    'subject_time_seconds', review_row.subject_time_seconds,
    'created_at', review_row.created_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_student_result_review(pg_catalog.uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_student_result_review(pg_catalog.uuid)
  TO authenticated, service_role;

COMMIT;
