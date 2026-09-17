-- Stage 22: atomic newest-login-wins takeover and submission-outcome recovery.
-- The previous Auth session identifier is used only inside this transaction to
-- decide whether a takeover occurred. It is never returned or written to audit.

BEGIN;

CREATE OR REPLACE FUNCTION public.claim_student_session()
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  claimed_session_id pg_catalog.uuid;
  previous_session_id pg_catalog.uuid;
  replaced_existing_session pg_catalog.bool := false;
  student_row public.students%ROWTYPE;
BEGIN
  claimed_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR claimed_session_id IS NULL THEN
    RAISE EXCEPTION 'A valid authenticated Supabase session is required';
  END IF;

  -- This same transaction lock is acquired by every authoritative student
  -- exam operation. A claim therefore happens wholly before or after a write.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      auth.uid()::pg_catalog.text OPERATOR(pg_catalog.||) ':student-session-claim',
      0
    )
  );

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found';
  END IF;
  IF student_row.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This student account is inactive';
  END IF;

  previous_session_id := student_row.active_auth_session_id;
  replaced_existing_session := previous_session_id IS NOT NULL
    AND previous_session_id OPERATOR(pg_catalog.<>) claimed_session_id;

  UPDATE public.students AS s
  SET active_auth_session_id = claimed_session_id
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid();

  IF replaced_existing_session THEN
    INSERT INTO public.admin_audit_events (
      actor_user_id,
      action,
      target_type,
      target_id,
      metadata
    ) VALUES (
      auth.uid(),
      'STUDENT_SESSION_TAKEOVER',
      'student',
      auth.uid()::pg_catalog.text,
      '{}'::pg_catalog.jsonb
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'session_id', claimed_session_id,
    'replaced_existing_session', replaced_existing_session,
    'student_id', student_row.student_id,
    'name', student_row.name,
    'class', student_row.class,
    'section', student_row.section
  );
END;
$function$;

COMMENT ON FUNCTION public.claim_student_session() IS
  'Atomically authorizes the caller JWT session for student operations. Returns only the new/current session ID and a takeover boolean; never the replaced session ID.';

REVOKE ALL ON FUNCTION public.claim_student_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_student_session() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.assert_current_student_session()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  expected_session_id pg_catalog.uuid;
  caller_user_id pg_catalog.uuid;
BEGIN
  caller_user_id := auth.uid();
  expected_session_id := public.current_auth_session_id();

  IF caller_user_id IS NULL OR expected_session_id IS NULL THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active';
  END IF;

  -- Held until the caller transaction ends, closing the check-then-write race
  -- between automatic takeover and start/autosave/submit/terminate operations.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_user_id::pg_catalog.text OPERATOR(pg_catalog.||) ':student-session-claim',
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.students AS s
    WHERE s.id OPERATOR(pg_catalog.=) caller_user_id
      AND s.archived_at IS NULL
      AND s.active_auth_session_id OPERATOR(pg_catalog.=) expected_session_id
  ) THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.assert_current_student_session() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_current_student_session() TO service_role;

CREATE OR REPLACE FUNCTION public.submit_exam(
  pg_catalog.uuid,
  pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  caller_user_id pg_catalog.uuid;
  caller_session_id pg_catalog.uuid;
  student_row public.students%ROWTYPE;
  result_row public.student_results%ROWTYPE;
BEGIN
  IF $2 IS NOT NULL
    AND pg_catalog.octet_length($2::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  caller_user_id := auth.uid();
  caller_session_id := public.current_auth_session_id();
  IF caller_user_id IS NULL OR caller_session_id IS NULL THEN
    RAISE EXCEPTION 'A valid authenticated Supabase session is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_user_id::pg_catalog.text OPERATOR(pg_catalog.||) ':student-session-claim',
      0
    )
  );

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) caller_user_id
    AND s.archived_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  -- A response may be lost after a successful commit. Even if a newer device
  -- has since taken over, return the already committed immutable result. This
  -- branch cannot create, alter, or delete a result or active session.
  IF student_row.active_auth_session_id IS DISTINCT FROM caller_session_id THEN
    SELECT r.*
    INTO result_row
    FROM public.student_results AS r
    WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
      AND r.exam_id OPERATOR(pg_catalog.=) $1::pg_catalog.text;

    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'totalScore', result_row.total_score,
        'maxScore', result_row.max_score,
        'correct', result_row.correct,
        'incorrect', result_row.incorrect,
        'unattempted', result_row.unattempted,
        'subjectScores', result_row.subject_scores
      );
    END IF;

    RAISE EXCEPTION 'This student session has been replaced or is no longer active';
  END IF;

  RETURN public.submit_exam_stage3_internal($1, $2);
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_exam(pg_catalog.uuid, pg_catalog.jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_exam(pg_catalog.uuid, pg_catalog.jsonb)
  TO authenticated, service_role;

COMMIT;
