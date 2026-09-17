-- Stage 21B, batch 1: identity, MFA, session ownership, and result lookup.

BEGIN;

CREATE OR REPLACE FUNCTION public.current_auth_session_id()
RETURNS pg_catalog.uuid
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  raw_session_id pg_catalog.text;
BEGIN
  raw_session_id := NULLIF(auth.jwt() ->> 'session_id', '');
  IF raw_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN raw_session_id::pg_catalog.uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin_aal2()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role pg_catalog.text;
  v_aal pg_catalog.text;
  v_jwt pg_catalog.jsonb;
BEGIN
  IF auth.role() OPERATOR(pg_catalog.=) 'service_role' THEN
    RETURN true;
  END IF;

  IF auth.role() OPERATOR(pg_catalog.<>) 'authenticated' OR auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  SELECT p.role
  INTO v_role
  FROM public.profiles AS p
  WHERE p.id OPERATOR(pg_catalog.=) auth.uid();

  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN false;
  END IF;

  BEGIN
    v_jwt := auth.jwt();
  EXCEPTION WHEN OTHERS THEN
    v_jwt := NULL;
  END;

  v_aal := COALESCE(
    v_jwt ->> 'aal',
    NULLIF(pg_catalog.current_setting('request.jwt.claim.aal', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::pg_catalog.jsonb ->> 'aal'
  );

  RETURN v_aal OPERATOR(pg_catalog.=) 'aal2';
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS pg_catalog.text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  user_role pg_catalog.text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT p.role
  INTO user_role
  FROM public.profiles AS p
  WHERE p.id OPERATOR(pg_catalog.=) auth.uid();

  RETURN user_role;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_student_session()
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  claimed_session_id pg_catalog.uuid;
  student_row public.students%ROWTYPE;
BEGIN
  claimed_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR claimed_session_id IS NULL THEN
    RAISE EXCEPTION 'A valid authenticated Supabase session is required';
  END IF;

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

  UPDATE public.students AS s
  SET active_auth_session_id = claimed_session_id
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid();

  RETURN pg_catalog.jsonb_build_object(
    'session_id', claimed_session_id,
    'student_id', student_row.student_id,
    'name', student_row.name,
    'class', student_row.class,
    'section', student_row.section
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.release_student_session()
RETURNS pg_catalog.bool
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  released_count pg_catalog.int4;
  caller_session_id pg_catalog.uuid;
BEGIN
  caller_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR caller_session_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.students AS s
  SET active_auth_session_id = NULL
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.active_auth_session_id OPERATOR(pg_catalog.=) caller_session_id;

  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count OPERATOR(pg_catalog.=) 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_current_student_session()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  expected_session_id pg_catalog.uuid;
BEGIN
  expected_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL
    OR expected_session_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.students AS s
      WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
        AND s.archived_at IS NULL
        AND s.active_auth_session_id OPERATOR(pg_catalog.=) expected_session_id
    )
  THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_student_exam_result(exam_id_param pg_catalog.text)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  student_row public.students%ROWTYPE;
  result_row public.student_results%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF exam_id_param IS NULL
    OR pg_catalog.octet_length(exam_id_param) OPERATOR(pg_catalog.<) 1
    OR pg_catalog.octet_length(exam_id_param) OPERATOR(pg_catalog.>) 128
  THEN
    RAISE EXCEPTION 'Invalid exam identifier';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_db_size()
RETURNS TABLE(table_name pg_catalog.text, size_bytes pg_catalog.int8)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  RETURN QUERY
  SELECT c.relname::pg_catalog.text,
    pg_catalog.pg_total_relation_size(c.oid)::pg_catalog.int8
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
  WHERE n.nspname OPERATOR(pg_catalog.=) 'public'
    AND c.relkind OPERATOR(pg_catalog.=) 'r'
  ORDER BY c.relname;
END;
$function$;

COMMIT;
