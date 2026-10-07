-- Migration: 20261007160000_exam_portal_changes.sql
-- Implements:
-- 1. Exam deletion (pending, active, ended with submissions) and root-only "Clear exam data"
-- 2. Immediate termination (Escape, tab switch, blur, fullscreen exit) and unlimited admin re-grants with access generation token rotation
-- 3. Paginated Terminated students view in Operations & Audit

-- ---------------------------------------------------------------------------
-- 1. Schema Extensions
-- ---------------------------------------------------------------------------

ALTER TABLE public.active_sessions
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK (status IN ('IN_PROGRESS', 'TERMINATED')),
  ADD COLUMN IF NOT EXISTS termination_reason text,
  ADD COLUMN IF NOT EXISTS terminated_at timestamptz,
  ADD COLUMN IF NOT EXISTS access_generation integer NOT NULL DEFAULT 1;

ALTER TABLE public.student_results
  ADD COLUMN IF NOT EXISTS was_terminated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS termination_reason text,
  ADD COLUMN IF NOT EXISTS terminated_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. Guard & Deletion Trigger Updates
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.protect_exam_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('cbt.trusted_exam_deletion', true) = 'on'
     OR (current_setting('cbt.trusted_exam_context', true) = 'on'
         AND current_setting('cbt.trusted_result_retention', true) = 'on') THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.student_results
    WHERE exam_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'Cannot delete exam "%" (%) because student submission results exist. Historical examination records must be retained. Set status to ENDED instead.',
      OLD.title, OLD.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.active_sessions
    WHERE exam_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'Cannot delete exam "%" (%) because students currently have active examination sessions.',
      OLD.title, OLD.id;
  END IF;

  DELETE FROM public.cbt_exam_answers WHERE exam_id = OLD.id;

  RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Audited Exam Deletion
-- ---------------------------------------------------------------------------


-- Text exam references need the same parent lock as a native foreign key.
CREATE OR REPLACE FUNCTION public.validate_result_exam_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM 1 FROM public.cbt_exams_raw WHERE id::text = NEW.exam_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referential integrity violation: exam_id "%" does not exist in cbt_exams_raw', NEW.exam_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_exam(
  exam_id_param uuid,
  expected_title_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  sessions_count bigint := 0;
  results_count bigint := 0;
  reviews_count bigint := 0;
  answers_count bigint := 0;
  status_events_count bigint := 0;
  audit_metadata jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  IF exam_id_param IS NULL OR expected_title_param IS NULL THEN
    RAISE EXCEPTION 'Exam ID and exact title confirmation are required';
  END IF;

  SELECT * INTO exam_row
  FROM public.cbt_exams_raw
  WHERE id = exam_id_param
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam was not found';
  END IF;

  IF expected_title_param IS DISTINCT FROM exam_row.title THEN
    RAISE EXCEPTION 'Exam title confirmation did not match';
  END IF;

  -- The parent lock blocks new attempts/results while collecting counts and deleting
  SELECT count(*) INTO sessions_count
  FROM public.active_sessions
  WHERE exam_id = exam_id_param::text;

  SELECT count(*) INTO results_count
  FROM public.student_results
  WHERE exam_id = exam_id_param::text;

  SELECT count(*) INTO reviews_count
  FROM public.student_result_reviews
  WHERE exam_id = exam_id_param;

  SELECT count(*) INTO answers_count
  FROM public.cbt_exam_answers
  WHERE exam_id = exam_id_param;

  SELECT count(*) INTO status_events_count
  FROM public.exam_status_events
  WHERE exam_id = exam_id_param;

  audit_metadata := pg_catalog.jsonb_build_object(
    'title', exam_row.title,
    'status', exam_row.status,
    'sessions_deleted', sessions_count,
    'results_deleted', results_count,
    'reviews_deleted', reviews_count,
    'answers_deleted', answers_count,
    'status_events_deleted', status_events_count
  );

  -- Record audit event BEFORE deleting
  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_EXAM', 'cbt_exam', exam_id_param::text,
    audit_metadata
  );

  -- Perform deletion under trusted context
  PERFORM pg_catalog.set_config('cbt.trusted_exam_deletion', 'on', true);
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);

  DELETE FROM public.active_sessions WHERE exam_id = exam_id_param::text;
  DELETE FROM public.student_result_reviews WHERE exam_id = exam_id_param;
  DELETE FROM public.student_results WHERE exam_id = exam_id_param::text;
  DELETE FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  DELETE FROM public.exam_status_events WHERE exam_id = exam_id_param;
  DELETE FROM public.cbt_exams_raw WHERE id = exam_id_param;

  RETURN pg_catalog.jsonb_build_object(
    'deleted', true,
    'exam_id', exam_id_param,
    'affected', audit_metadata
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_unused_exam(
  exam_id_param uuid,
  expected_title_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.admin_delete_exam(exam_id_param, expected_title_param);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_exam(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_exam(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_unused_exam(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_unused_exam(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Root-Only Clear Exam Data
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.root_clear_exam_data_preview()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  counts jsonb;
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'exams', (SELECT pg_catalog.count(*) FROM public.cbt_exams_raw),
    'active_sessions', (SELECT pg_catalog.count(*) FROM public.active_sessions),
    'results', (SELECT pg_catalog.count(*) FROM public.student_results),
    'reviews', (SELECT pg_catalog.count(*) FROM public.student_result_reviews),
    'answers', (SELECT pg_catalog.count(*) FROM public.cbt_exam_answers),
    'status_events', (SELECT pg_catalog.count(*) FROM public.exam_status_events)
  ) INTO counts;

  RETURN counts;
END;
$$;

CREATE OR REPLACE FUNCTION public.root_clear_exam_data(confirmation_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  counts jsonb;
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR EXAM DATA' THEN
    RAISE EXCEPTION 'Exact clear confirmation is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(2026100716);
  LOCK TABLE
    public.cbt_exams_raw,
    public.active_sessions,
    public.student_result_reviews,
    public.student_results,
    public.cbt_exam_answers,
    public.exam_status_events
  IN ACCESS EXCLUSIVE MODE;

  counts := public.root_clear_exam_data_preview();

  -- Record audit event BEFORE deleting
  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    actor_id,
    'CLEAR_EXAM_DATA',
    'exams',
    NULL,
    pg_catalog.jsonb_build_object(
      'deleted', counts,
      'preserved', 'students_classes_subjects_patterns_question_bank_imports_settings_audit_storage'
    )
  );

  PERFORM pg_catalog.set_config('cbt.trusted_exam_deletion', 'on', true);
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);

  DELETE FROM public.active_sessions;
  DELETE FROM public.student_result_reviews;
  DELETE FROM public.student_results;
  DELETE FROM public.cbt_exam_answers;
  DELETE FROM public.cbt_exams_raw;
  DELETE FROM public.exam_status_events;

  RETURN pg_catalog.jsonb_build_object(
    'cleared', true,
    'deleted', counts,
    'preserved', 'students_classes_subjects_patterns_question_bank_imports_settings_audit_storage'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.root_clear_exam_data_preview_for_actor(actor_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner
    WHERE owner.user_id = actor_id_param
  ) THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  RETURN public.root_clear_exam_data_preview();
END;
$$;

CREATE OR REPLACE FUNCTION public.root_clear_exam_data_for_actor(
  actor_id_param uuid,
  confirmation_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner
    WHERE owner.user_id = actor_id_param
  ) THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  RETURN public.root_clear_exam_data(confirmation_param);
END;
$$;

REVOKE ALL ON FUNCTION public.root_clear_exam_data_preview() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_exam_data(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_exam_data_preview_for_actor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_clear_exam_data_for_actor(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.root_clear_exam_data_preview_for_actor(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.root_clear_exam_data_for_actor(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Immediate Termination & Session State
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.terminate_exam(uuid);
DROP FUNCTION IF EXISTS public.terminate_exam_internal(uuid);

CREATE OR REPLACE FUNCTION public.terminate_exam_internal(
  exam_id_param uuid,
  reason_param text DEFAULT 'ended',
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_id text;
  chosen_reason text := COALESCE(NULLIF(pg_catalog.btrim(reason_param), ''), 'ended');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = 'EX004';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id = auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id || ':' || exam_id_param::text,
      0
    )
  );

  session_id := student_row.id::text || '_' || exam_id_param::text;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id = session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.student_results
      WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'terminated', true,
        'finalized', true,
        'reason', chosen_reason
      );
    END IF;
    RAISE EXCEPTION 'Exam session was not started correctly' USING ERRCODE = 'EX009';
  END IF;

  -- Stale generation rejection: prevents delayed retry from terminating a re-granted attempt
  IF access_generation_param IS NOT NULL AND access_generation_param <> session_row.access_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'terminated', false,
      'stale_generation', true,
      'access_generation', session_row.access_generation
    );
  END IF;

  IF session_row.status = 'TERMINATED' THEN
    RETURN pg_catalog.jsonb_build_object(
      'terminated', true,
      'reason', session_row.termination_reason,
      'terminated_at', session_row.terminated_at,
      'access_generation', session_row.access_generation
    );
  END IF;

  UPDATE public.active_sessions
  SET status = 'TERMINATED',
      termination_reason = chosen_reason,
      terminated_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = session_id
  RETURNING * INTO session_row;

  RETURN pg_catalog.jsonb_build_object(
    'terminated', true,
    'reason', session_row.termination_reason,
    'terminated_at', session_row.terminated_at,
    'access_generation', session_row.access_generation
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.terminate_exam(
  exam_id_param uuid,
  reason_param text DEFAULT 'ended',
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_current_student_session();
  IF access_generation_param IS NULL OR access_generation_param < 1 THEN
    RAISE EXCEPTION 'A positive access generation is required' USING ERRCODE = 'EX015';
  END IF;

  RETURN public.terminate_exam_internal(exam_id_param, reason_param, access_generation_param);
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_exam_internal(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_exam_internal(uuid, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.terminate_exam(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid, text, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Start / Resume Session Updates
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_exam_session_internal(
  exam_id_param uuid,
  exam_data_param jsonb,
  responses_param jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row public.cbt_exams_raw%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  duration_seconds pg_catalog.int4;
  remaining_seconds pg_catalog.int4;
  session_id pg_catalog.text;
  subject_name pg_catalog.text;
  shuffled_questions pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  shuffled_subject pg_catalog.jsonb;
  server_exam_data pg_catalog.jsonb;
  initial_responses pg_catalog.jsonb;
  start_time pg_catalog.timestamptz;
  final_result pg_catalog.jsonb;
BEGIN
  PERFORM exam_data_param, responses_param;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = 'EX004';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id = auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;

  PERFORM 1 FROM public.cbt_exams_raw
  WHERE id = exam_id_param FOR KEY SHARE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id || ':' || exam_id_param::text,
      0
    )
  );

  SELECT e.*
  INTO exam_row
  FROM public.cbt_exams_raw AS e
  WHERE e.id = exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This exam is not available' USING ERRCODE = 'EX007';
  END IF;

  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class = 'All'
    OR exam_row.class = student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section = 'All'
    OR exam_row.section = student_row.section
  ) THEN
    RAISE EXCEPTION 'This exam is not assigned to you' USING ERRCODE = 'EX006';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.student_results AS r
    WHERE r.student_id = student_row.student_id
      AND r.exam_id = exam_id_param::text
  ) THEN
    RAISE EXCEPTION 'This exam has already been submitted' USING ERRCODE = 'EX005';
  END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id = session_id;

  IF FOUND THEN
    IF exam_row.status NOT IN ('ACTIVE', 'ENDED') OR session_row.started_at IS NULL THEN
      RAISE EXCEPTION 'This exam session is not available' USING ERRCODE = 'EX007';
    END IF;

    IF session_row.deadline_at IS NULL THEN
      duration_seconds := GREATEST(
        COALESCE(((session_row.jumbled_exam_data ->> 'duration')::pg_catalog.int4), 180),
        1
      ) * 60;
      UPDATE public.active_sessions AS s
      SET deadline_at = session_row.started_at + pg_catalog.make_interval(secs => duration_seconds)
      WHERE s.id = session_id
      RETURNING s.* INTO session_row;
    END IF;

    IF pg_catalog.clock_timestamp() >= session_row.deadline_at THEN
      final_result := public.submit_exam_internal(exam_id_param, '[]'::pg_catalog.jsonb);
      RETURN pg_catalog.jsonb_build_object(
        'expired', true,
        'time_left', 0,
        'result', final_result
      );
    END IF;

    remaining_seconds := GREATEST(
      pg_catalog.ceil(
        EXTRACT(EPOCH FROM (session_row.deadline_at - pg_catalog.clock_timestamp()))
      )::pg_catalog.int4,
      0
    );

    IF session_row.status = 'TERMINATED' THEN
      RETURN pg_catalog.jsonb_build_object(
        'terminated', true,
        'status', 'TERMINATED',
        'reason', session_row.termination_reason,
        'terminated_at', session_row.terminated_at,
        'time_left', remaining_seconds,
        'deadline_at', session_row.deadline_at,
        'access_generation', session_row.access_generation
      );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'time_left', remaining_seconds,
      'started_at', session_row.started_at,
      'deadline_at', session_row.deadline_at,
      'jumbled_exam_data', session_row.jumbled_exam_data,
      'user_responses', session_row.user_responses,
      'version', session_row.version,
      'access_generation', session_row.access_generation,
      'status', session_row.status
    );
  END IF;

  IF exam_row.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'This exam is not available' USING ERRCODE = 'EX007';
  END IF;
  IF pg_catalog.jsonb_typeof(exam_row.questions_data -> 'questions') <> 'object' THEN
    RAISE EXCEPTION 'Exam question data is invalid' USING ERRCODE = 'EX012';
  END IF;

  FOR subject_name IN
    SELECT pg_catalog.jsonb_object_keys(exam_row.questions_data -> 'questions')
  LOOP
    WITH items AS (
      SELECT
        question.value AS question,
        question.ordinality AS position,
        COALESCE(
          question.value -> 'details' -> 'passage' ->> 'key',
          'q' || question.ordinality::text
        ) AS block
      FROM pg_catalog.jsonb_array_elements(
        exam_row.questions_data -> 'questions' -> subject_name
      ) WITH ORDINALITY AS question
    ), blocks AS (
      SELECT items.block, pg_catalog.random() AS draw
      FROM items
      GROUP BY items.block
    )
    SELECT COALESCE(
      pg_catalog.jsonb_agg(items.question ORDER BY blocks.draw, blocks.block, items.position),
      '[]'::pg_catalog.jsonb
    )
    INTO shuffled_subject
    FROM items
    JOIN blocks ON blocks.block = items.block;
    shuffled_questions := pg_catalog.jsonb_set(
      shuffled_questions,
      ARRAY[subject_name],
      shuffled_subject,
      true
    );
  END LOOP;

  server_exam_data := pg_catalog.jsonb_set(
    exam_row.questions_data,
    '{questions}',
    shuffled_questions,
    true
  );
  initial_responses := public.sanitize_exam_responses(
    '{}'::pg_catalog.jsonb,
    server_exam_data -> 'questions'
  );
  duration_seconds := GREATEST(
    COALESCE(((server_exam_data ->> 'duration')::pg_catalog.int4), 180),
    1
  ) * 60;
  start_time := pg_catalog.clock_timestamp();

  INSERT INTO public.active_sessions (
    id,
    student_id,
    exam_id,
    user_responses,
    jumbled_exam_data,
    time_left,
    started_at,
    deadline_at,
    updated_at,
    version,
    access_generation,
    status
  ) VALUES (
    session_id,
    student_row.student_id,
    exam_id_param::text,
    initial_responses,
    server_exam_data,
    duration_seconds,
    start_time,
    start_time + pg_catalog.make_interval(secs => duration_seconds),
    start_time,
    1,
    1,
    'IN_PROGRESS'
  )
  RETURNING * INTO session_row;

  RETURN pg_catalog.jsonb_build_object(
    'time_left', duration_seconds,
    'started_at', session_row.started_at,
    'deadline_at', session_row.deadline_at,
    'jumbled_exam_data', session_row.jumbled_exam_data,
    'user_responses', session_row.user_responses,
    'version', session_row.version,
    'access_generation', session_row.access_generation,
    'status', session_row.status
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Student Mutation Guards (Access Generation & Terminated Check)
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.sync_active_session_progress(uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.sync_active_session_progress_internal(uuid, jsonb, integer);

CREATE OR REPLACE FUNCTION public.sync_active_session_progress_internal(
  exam_id_param uuid,
  responses_param jsonb,
  expected_version_param integer,
  access_generation_param integer DEFAULT NULL
)
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
  WHERE s.id = auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;
  IF expected_version_param IS NULL OR expected_version_param < 1 THEN
    RAISE EXCEPTION 'A positive expected session version is required' USING ERRCODE = 'EX012';
  END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id || ':' || exam_id_param::text,
      0
    )
  );

  SELECT s.id, s.version, s.deadline_at, s.response_schema, s.status, s.access_generation
  INTO session_row.id, session_row.version, session_row.deadline_at, session_row.response_schema, session_row.status, session_row.access_generation
  FROM public.active_sessions AS s
  WHERE s.id = session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted' USING ERRCODE = 'EX011';
  END IF;

  IF session_row.status = 'TERMINATED' THEN
    RAISE EXCEPTION 'Active session is terminated' USING ERRCODE = 'EX014';
  END IF;

  IF access_generation_param IS NOT NULL AND access_generation_param <> session_row.access_generation THEN
    RAISE EXCEPTION 'Session access generation mismatch' USING ERRCODE = 'EX015';
  END IF;

  IF expected_version_param <> session_row.version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'access_generation', session_row.access_generation,
      'user_responses', (
        SELECT s.user_responses FROM public.active_sessions AS s
        WHERE s.id = session_id
      )
    );
  END IF;

  IF session_row.deadline_at IS NULL
    OR pg_catalog.clock_timestamp() >= session_row.deadline_at
  THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved' USING ERRCODE = 'EX008';
  END IF;

  canonical_responses := public.sanitize_exam_responses(
    responses_param,
    COALESCE(
      session_row.response_schema -> 'questions',
      (SELECT s.jumbled_exam_data -> 'questions' FROM public.active_sessions AS s
       WHERE s.id = session_id)
    )
  );
  new_version := session_row.version + 1;
  UPDATE public.active_sessions AS s
  SET user_responses = canonical_responses,
      updated_at = pg_catalog.clock_timestamp(),
      version = new_version
  WHERE s.id = session_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'conflict', false,
    'version', new_version,
    'access_generation', session_row.access_generation,
    'saved_at', pg_catalog.clock_timestamp()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_active_session_progress(
  exam_id_param uuid,
  responses_param jsonb,
  expected_version_param integer,
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::text) > 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  IF access_generation_param IS NULL OR access_generation_param < 1 THEN
    RAISE EXCEPTION 'A positive access generation is required' USING ERRCODE = 'EX015';
  END IF;

  RETURN public.sync_active_session_progress_internal(exam_id_param, responses_param, expected_version_param, access_generation_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_active_session_progress_internal(uuid, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress_internal(uuid, jsonb, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer, integer) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.sync_exam_subject_time(uuid, jsonb);
DROP FUNCTION IF EXISTS public.sync_exam_subject_time_internal(uuid, jsonb);

CREATE OR REPLACE FUNCTION public.sync_exam_subject_time_internal(
  exam_id_param uuid,
  subject_time_seconds_param jsonb,
  access_generation_param integer DEFAULT NULL
)
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
  session_id text;
BEGIN
  IF exam_id_param IS NULL
    OR subject_time_seconds_param IS NULL
    OR pg_catalog.jsonb_typeof(subject_time_seconds_param) OPERATOR(pg_catalog.<>) 'object'
    OR pg_catalog.octet_length(subject_time_seconds_param::pg_catalog.text) OPERATOR(pg_catalog.>) 4096
  THEN
    RAISE EXCEPTION 'Invalid subject timing payload';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;

  session_id := student_row.id::text || '_' || exam_id_param::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id || ':' || exam_id_param::text,
      0
    )
  );

  SELECT session.id, session.status, session.access_generation, session.subject_time_seconds, session.started_at,
         session.deadline_at,
         COALESCE(session.response_schema -> 'subjects', session.jumbled_exam_data -> 'subjects'),
         COALESCE((session.response_schema ->> 'duration'), (session.jumbled_exam_data ->> 'duration'))::pg_catalog.int4
  INTO session_row.id, session_row.status, session_row.access_generation, session_row.subject_time_seconds, session_row.started_at,
       session_row.deadline_at, session_subjects, session_duration
  FROM public.active_sessions AS session
  WHERE session.id OPERATOR(pg_catalog.=) session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted' USING ERRCODE = 'EX011';
  END IF;

  IF session_row.status = 'TERMINATED' THEN
    RAISE EXCEPTION 'Active session is terminated' USING ERRCODE = 'EX014';
  END IF;

  IF access_generation_param IS NOT NULL AND access_generation_param <> session_row.access_generation THEN
    RAISE EXCEPTION 'Session access generation mismatch' USING ERRCODE = 'EX015';
  END IF;

  IF session_row.deadline_at IS NULL OR pg_catalog.clock_timestamp() >= session_row.deadline_at THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved' USING ERRCODE = 'EX008';
  END IF;

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
  SET subject_time_seconds = merged_time,
      updated_at = pg_catalog.clock_timestamp()
  WHERE session.id OPERATOR(pg_catalog.=) session_row.id;

  RETURN merged_time;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_exam_subject_time(
  exam_id_param uuid,
  subject_time_seconds_param jsonb,
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  PERFORM public.assert_current_student_session();
  IF access_generation_param IS NULL OR access_generation_param < 1 THEN
    RAISE EXCEPTION 'A positive access generation is required' USING ERRCODE = 'EX015';
  END IF;

  RETURN public.sync_exam_subject_time_internal(exam_id_param, subject_time_seconds_param, access_generation_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_exam_subject_time_internal(uuid, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_exam_subject_time_internal(uuid, jsonb, integer) TO service_role;
REVOKE ALL ON FUNCTION public.sync_exam_subject_time(uuid, jsonb, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_exam_subject_time(uuid, jsonb, integer) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.submit_exam(uuid, jsonb, integer);
DROP FUNCTION IF EXISTS public.submit_exam(uuid, jsonb);
DROP FUNCTION IF EXISTS public.submit_exam_internal(uuid, jsonb);
DROP FUNCTION IF EXISTS public.submit_exam_internal(uuid, jsonb, integer);

CREATE OR REPLACE FUNCTION public.submit_exam_internal(
  exam_id_param uuid,
  responses_param jsonb,
  expected_version_param integer DEFAULT NULL,
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  result_row public.student_results%ROWTYPE;
  answers_obj pg_catalog.jsonb;
  response_map pg_catalog.jsonb;
  server_submission pg_catalog.jsonb;
  answer_entry pg_catalog.record;
  answer_data pg_catalog.jsonb;
  response_data pg_catalog.jsonb;
  total_score pg_catalog.numeric := 0;
  correct_count pg_catalog.int4 := 0;
  partial_count pg_catalog.int4 := 0;
  incorrect_count pg_catalog.int4 := 0;
  unattempted_count pg_catalog.int4 := 0;
  total_questions pg_catalog.int4 := 0;
  subject_scores pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  subject_name pg_catalog.text;
  is_attempted pg_catalog.bool;
  max_score pg_catalog.numeric := 0;
  question_scores pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  question_marking pg_catalog.jsonb;
  question_score pg_catalog.jsonb;
  outcome pg_catalog.text;
  delta pg_catalog.numeric;
  new_result_id pg_catalog.uuid;
  session_was_terminated boolean := false;
  session_term_reason text;
  session_term_at timestamptz;
BEGIN
  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found' USING ERRCODE = 'EX002';
  END IF;

  PERFORM 1 FROM public.cbt_exams_raw
  WHERE id = exam_id_param FOR KEY SHARE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'totalScore', result_row.total_score,
      'maxScore', result_row.max_score,
      'correct', result_row.correct,
      'partial', result_row.partial,
      'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted,
      'subjectScores', result_row.subject_scores
    );
  END IF;

  SELECT e.*
  INTO exam_row
  FROM public.cbt_exams_raw AS e
  WHERE e.id OPERATOR(pg_catalog.=) exam_id_param;
  IF NOT FOUND OR exam_row.status NOT IN ('ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'This exam is not available for submission' USING ERRCODE = 'EX007';
  END IF;
  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class OPERATOR(pg_catalog.=) 'All'
    OR exam_row.class OPERATOR(pg_catalog.=) student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section OPERATOR(pg_catalog.=) 'All'
    OR exam_row.section OPERATOR(pg_catalog.=) student_row.section
  ) THEN
    RAISE EXCEPTION 'This exam is not assigned to you' USING ERRCODE = 'EX006';
  END IF;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) (
    student_row.id::pg_catalog.text
      OPERATOR(pg_catalog.||) '_'
      OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text
  )
  FOR UPDATE;
  IF NOT FOUND OR session_row.started_at IS NULL OR session_row.deadline_at IS NULL THEN
    RAISE EXCEPTION 'Exam session was not started correctly' USING ERRCODE = 'EX009';
  END IF;

  -- Block manual submission while terminated before deadline
  IF session_row.status = 'TERMINATED' AND pg_catalog.clock_timestamp() < session_row.deadline_at THEN
    RAISE EXCEPTION 'Cannot submit a terminated exam before deadline' USING ERRCODE = 'EX014';
  END IF;

  IF access_generation_param IS NOT NULL AND access_generation_param <> session_row.access_generation THEN
    RAISE EXCEPTION 'Session access generation mismatch' USING ERRCODE = 'EX015';
  END IF;

  session_was_terminated := (session_row.status = 'TERMINATED');
  session_term_reason := session_row.termination_reason;
  session_term_at := session_row.terminated_at;

  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB' USING ERRCODE = 'EX012';
  END IF;

  -- At/after the strict deadline, or if session was terminated, or versioned submit, grade only the server snapshot.
  IF pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
    OR session_was_terminated
    OR expected_version_param IS NOT NULL
    OR responses_param IS NULL
    OR (
      pg_catalog.jsonb_typeof(responses_param) OPERATOR(pg_catalog.=) 'array'
      AND pg_catalog.jsonb_array_length(responses_param) OPERATOR(pg_catalog.=) 0
    )
  THEN
    server_submission := public.exam_progress_to_submission(
      session_row.user_responses,
      session_row.jumbled_exam_data -> 'questions'
    );
    response_map := public.normalize_submission_response_map(
      server_submission,
      session_row.jumbled_exam_data -> 'questions'
    );
  ELSE
    response_map := public.normalize_submission_response_map(
      responses_param,
      session_row.jumbled_exam_data -> 'questions'
    );
  END IF;

  SELECT a.answers
  INTO answers_obj
  FROM public.cbt_exam_answers AS a
  WHERE a.exam_id OPERATOR(pg_catalog.=) exam_id_param;
  IF answers_obj IS NULL THEN
    RAISE EXCEPTION 'Answer key not found' USING ERRCODE = 'EX010';
  END IF;

  FOR answer_entry IN
    SELECT item.key, item.value
    FROM pg_catalog.jsonb_each(answers_obj) AS item
  LOOP
    total_questions := total_questions OPERATOR(pg_catalog.+) 1;
    answer_data := answer_entry.value;
    response_data := COALESCE(response_map -> answer_entry.key, '{}'::pg_catalog.jsonb);
    subject_name := COALESCE(NULLIF(answer_data ->> 'subject', ''), 'General');
    subject_scores := pg_catalog.jsonb_set(
      subject_scores,
      ARRAY[subject_name],
      COALESCE(subject_scores -> subject_name, '0'::pg_catalog.jsonb),
      true
    );
    is_attempted := COALESCE(
      (response_data ->> 'status') IN ('ANSWERED', 'ANSWERED_MARKED')
        AND NULLIF(pg_catalog.btrim(response_data ->> 'selected_option'), '') IS NOT NULL,
      false
    );
    -- Per-type marks (falling back to the exam-wide marks) and the shared
    -- scorer: CORRECT / PARTIAL / INCORRECT / UNATTEMPTED with its marks.
    question_marking := public.resolve_question_marking(session_row.jumbled_exam_data, answer_data ->> 'type');
    max_score := max_score OPERATOR(pg_catalog.+) (question_marking ->> 'correct')::pg_catalog.numeric;
    question_score := public.score_question_response(
      answer_data ->> 'type',
      answer_data ->> 'correct_answer',
      CASE WHEN is_attempted THEN response_data ->> 'selected_option' END,
      question_marking
    );
    question_scores := pg_catalog.jsonb_set(question_scores, ARRAY[answer_entry.key], question_score, true);
    outcome := question_score ->> 'outcome';
    delta := (question_score ->> 'marks')::pg_catalog.numeric;

    IF outcome OPERATOR(pg_catalog.=) 'UNATTEMPTED' THEN
      unattempted_count := unattempted_count OPERATOR(pg_catalog.+) 1;
    ELSIF outcome OPERATOR(pg_catalog.=) 'CORRECT' THEN
      correct_count := correct_count OPERATOR(pg_catalog.+) 1;
    ELSIF outcome OPERATOR(pg_catalog.=) 'PARTIAL' THEN
      partial_count := partial_count OPERATOR(pg_catalog.+) 1;
    ELSE
      incorrect_count := incorrect_count OPERATOR(pg_catalog.+) 1;
    END IF;
    IF outcome OPERATOR(pg_catalog.<>) 'UNATTEMPTED' THEN
      total_score := total_score OPERATOR(pg_catalog.+) delta;
      subject_scores := pg_catalog.jsonb_set(
        subject_scores,
        ARRAY[subject_name],
        pg_catalog.to_jsonb(
          COALESCE((subject_scores ->> subject_name)::pg_catalog.numeric, 0)
            OPERATOR(pg_catalog.+) delta
        ),
        true
      );
    END IF;
  END LOOP;

  INSERT INTO public.student_results (
    exam_id,
    student_id,
    student_name,
    total_score,
    max_score,
    correct,
    partial,
    incorrect,
    unattempted,
    subject_scores,
    submitted_at,
    was_terminated,
    termination_reason,
    terminated_at
  ) VALUES (
    exam_id_param::pg_catalog.text,
    student_row.student_id,
    student_row.name,
    total_score,
    max_score,
    correct_count,
    partial_count,
    incorrect_count,
    unattempted_count,
    subject_scores,
    pg_catalog.clock_timestamp(),
    session_was_terminated,
    session_term_reason,
    session_term_at
  )
  ON CONFLICT (student_id, exam_id) DO NOTHING
  RETURNING id INTO new_result_id;

  -- The administrator answer review stores exactly what was graded, keyed by
  -- question ID (the capture trigger's positional snapshot cannot be matched
  -- to the shuffled paper).
  IF new_result_id IS NOT NULL THEN
    INSERT INTO public.student_result_reviews (
      result_id,
      exam_id,
      student_id,
      response_snapshot,
      subject_time_seconds,
      snapshot_format,
      question_scores
    ) VALUES (
      new_result_id,
      exam_id_param,
      student_row.student_id,
      response_map,
      COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb),
      'by_question_id',
      question_scores
    )
    ON CONFLICT (result_id) DO UPDATE
    SET response_snapshot = EXCLUDED.response_snapshot,
        snapshot_format = EXCLUDED.snapshot_format,
        question_scores = EXCLUDED.question_scores;
  END IF;

  DELETE FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_row.id;

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text;

  RETURN pg_catalog.jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'partial', result_row.partial,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_exam(
  exam_id_param uuid,
  responses_param jsonb,
  expected_version_param integer DEFAULT NULL,
  access_generation_param integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  result_row public.student_results%ROWTYPE;
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::text) > 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  BEGIN
    PERFORM public.assert_current_student_session();
  EXCEPTION WHEN OTHERS THEN
    SELECT r.*
    INTO result_row
    FROM public.students AS s
    JOIN public.student_results AS r
      ON r.student_id = s.student_id
     AND r.exam_id = exam_id_param::text
    WHERE s.id = auth.uid();

    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'totalScore', result_row.total_score,
        'maxScore', result_row.max_score,
        'correct', result_row.correct,
        'partial', result_row.partial,
        'incorrect', result_row.incorrect,
        'unattempted', result_row.unattempted,
        'subjectScores', result_row.subject_scores
      );
    END IF;
    RAISE;
  END;

  IF access_generation_param IS NULL OR access_generation_param < 1 THEN
    RAISE EXCEPTION 'A positive access generation is required' USING ERRCODE = 'EX015';
  END IF;

  IF expected_version_param IS NOT NULL THEN
    RETURN public.submit_exam_internal(exam_id_param, NULL, expected_version_param, access_generation_param);
  END IF;

  RETURN public.submit_exam_internal(exam_id_param, responses_param, NULL, access_generation_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_exam_internal(uuid, jsonb, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_exam_internal(uuid, jsonb, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.submit_exam(uuid, jsonb, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb, integer, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Admin Re-Grant RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_regrant_exam_access(session_id_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  session_row public.active_sessions%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  IF session_id_param IS NULL THEN
    RAISE EXCEPTION 'Session ID is required';
  END IF;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id = session_id_param
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.student_results
      WHERE (student_id || '_' || exam_id) = session_id_param
    ) THEN
      RAISE EXCEPTION 'Exam attempt has already been finalized; access cannot be re-granted';
    END IF;
    RAISE EXCEPTION 'Active session not found';
  END IF;

  IF session_row.deadline_at IS NOT NULL AND pg_catalog.clock_timestamp() >= session_row.deadline_at THEN
    RAISE EXCEPTION 'Exam deadline has expired; access cannot be re-granted';
  END IF;

  IF session_row.status IS DISTINCT FROM 'TERMINATED' THEN
    RAISE EXCEPTION 'Session is not terminated';
  END IF;

  UPDATE public.active_sessions
  SET status = 'IN_PROGRESS',
      termination_reason = NULL,
      terminated_at = NULL,
      access_generation = session_row.access_generation + 1,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = session_row.id;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'REGRANT_EXAM_ACCESS', 'active_session', session_row.id,
    pg_catalog.jsonb_build_object(
      'student_id', session_row.student_id,
      'exam_id', session_row.exam_id,
      'previous_generation', session_row.access_generation,
      'new_generation', session_row.access_generation + 1,
      'deadline_at', session_row.deadline_at
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'session_id', session_row.id,
    'access_generation', session_row.access_generation + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_regrant_exam_access(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_regrant_exam_access(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Terminated Students Page RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_admin_terminated_students_page(
  page_number_param integer DEFAULT 1,
  page_size_param integer DEFAULT 20,
  search_param text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page integer := GREATEST(COALESCE(page_number_param, 1), 1);
  v_size integer := LEAST(GREATEST(COALESCE(page_size_param, 20), 1), 100);
  v_offset integer := (v_page - 1) * v_size;
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_search text := NULLIF(pg_catalog.btrim(search_param), '');
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  WITH combined_terminated AS (
    SELECT
      s.id AS session_id,
      s.student_id,
      st.name AS student_name,
      s.exam_id,
      COALESCE(e.title, 'Unknown Exam') AS exam_title,
      s.termination_reason,
      s.terminated_at,
      s.deadline_at,
      (s.deadline_at IS NOT NULL AND pg_catalog.clock_timestamp() < s.deadline_at) AS eligible,
      'TERMINATED' AS attempt_state,
      s.access_generation
    FROM public.active_sessions AS s
    JOIN public.students AS st ON st.student_id = s.student_id
    LEFT JOIN public.cbt_exams_raw AS e ON e.id::text = s.exam_id
    WHERE s.status = 'TERMINATED'

    UNION ALL

    SELECT
      (r.student_id || '_' || r.exam_id) AS session_id,
      r.student_id,
      r.student_name,
      r.exam_id,
      COALESCE(e.title, 'Unknown Exam') AS exam_title,
      r.termination_reason,
      r.terminated_at,
      r.submitted_at AS deadline_at,
      false AS eligible,
      'FINALIZED' AS attempt_state,
      0 AS access_generation
    FROM public.student_results AS r
    LEFT JOIN public.cbt_exams_raw AS e ON e.id::text = r.exam_id
    WHERE r.was_terminated = true
  ),
  filtered AS (
    SELECT *
    FROM combined_terminated
    WHERE v_search IS NULL
       OR student_name ILIKE ('%' || v_search || '%')
       OR student_id ILIKE ('%' || v_search || '%')
       OR exam_title ILIKE ('%' || v_search || '%')
  )
  SELECT
    (SELECT COUNT(*)::integer FROM filtered),
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'session_id', session_id,
          'student_id', student_id,
          'student_name', student_name,
          'exam_id', exam_id,
          'exam_title', exam_title,
          'termination_reason', termination_reason,
          'terminated_at', terminated_at,
          'deadline_at', deadline_at,
          'eligible', eligible,
          'attempt_state', attempt_state,
          'access_generation', access_generation
        )
        ORDER BY terminated_at DESC NULLS LAST, session_id
      ),
      '[]'::jsonb
    )
  INTO v_total, v_rows
  FROM (
    SELECT *
    FROM filtered
    ORDER BY terminated_at DESC NULLS LAST, session_id
    LIMIT v_size OFFSET v_offset
  ) AS page_data;

  RETURN jsonb_build_object(
    'page', v_page,
    'pageSize', v_size,
    'total', v_total,
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_terminated_students_page(integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_terminated_students_page(integer, integer, text) TO authenticated, service_role;
