-- #6: stable, machine-readable error codes for the errors the app reacts to.
--
-- Messages are unchanged (older clients and tests still match on them), but the
-- session guards now raise with explicit SQLSTATEs in the application-defined
-- "EX" class. PostgREST returns these as `code`, and src/appErrors.js maps them:
--   EX001  student session replaced / no longer active
--   EX002  student profile not found
--   EX003  student account inactive
--   EX004  authenticated session required
-- See docs/ERROR_CODES.md for the full catalogue.

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_current_student_session()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  expected_session_id pg_catalog.uuid;
  caller_user_id pg_catalog.uuid;
BEGIN
  caller_user_id := auth.uid();
  expected_session_id := public.current_auth_session_id();

  IF caller_user_id IS NULL OR expected_session_id IS NULL THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active' USING ERRCODE = 'EX001';
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
    RAISE EXCEPTION 'This student session has been replaced or is no longer active' USING ERRCODE = 'EX001';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_student_session()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  claimed_session_id pg_catalog.uuid;
  previous_session_id pg_catalog.uuid;
  replaced_existing_session pg_catalog.bool := false;
  student_row public.students%ROWTYPE;
BEGIN
  claimed_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR claimed_session_id IS NULL THEN
    RAISE EXCEPTION 'A valid authenticated Supabase session is required' USING ERRCODE = 'EX004';
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
    RAISE EXCEPTION 'Student profile not found' USING ERRCODE = 'EX002';
  END IF;
  IF student_row.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This student account is inactive' USING ERRCODE = 'EX003';
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

COMMIT;
