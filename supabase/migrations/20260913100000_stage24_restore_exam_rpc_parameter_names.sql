-- Stage 24: restore stable PostgREST parameter names on browser-facing exam RPCs.
--
-- Stage 21 hardened these wrappers with unnamed arguments. PostgreSQL can call
-- unnamed arguments positionally, but PostgREST requires stable argument names
-- for JSON-object RPC calls. Recreate only the thin public wrappers; the
-- authoritative internal implementations remain unchanged.

BEGIN;

DROP FUNCTION public.start_exam_session(pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.jsonb);

CREATE FUNCTION public.start_exam_session(
  exam_id_param pg_catalog.uuid,
  exam_data_param pg_catalog.jsonb,
  responses_param pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF exam_data_param IS NOT NULL
    AND pg_catalog.octet_length(exam_data_param::pg_catalog.text) OPERATOR(pg_catalog.>) 8388608
  THEN
    RAISE EXCEPTION 'Exam payload exceeds 8 MiB';
  END IF;
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.start_exam_session_stage3_internal(
    exam_id_param,
    exam_data_param,
    responses_param
  );
END;
$function$;

DROP FUNCTION public.submit_exam(pg_catalog.uuid, pg_catalog.jsonb);

CREATE FUNCTION public.submit_exam(
  exam_id_param pg_catalog.uuid,
  responses_param pg_catalog.jsonb
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.submit_exam_stage3_internal(exam_id_param, responses_param);
END;
$function$;

DROP FUNCTION public.sync_active_session_progress(
  pg_catalog.uuid,
  pg_catalog.jsonb,
  pg_catalog.int4
);

CREATE FUNCTION public.sync_active_session_progress(
  exam_id_param pg_catalog.uuid,
  responses_param pg_catalog.jsonb,
  expected_version_param pg_catalog.int4
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.sync_active_session_progress_stage3_internal(
    exam_id_param,
    responses_param,
    expected_version_param
  );
END;
$function$;

DROP FUNCTION public.terminate_exam(pg_catalog.uuid);

CREATE FUNCTION public.terminate_exam(exam_id_param pg_catalog.uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.assert_current_student_session();
  PERFORM public.terminate_exam_stage3_internal(exam_id_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_exam(uuid, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.terminate_exam(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid) TO authenticated;

COMMENT ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) IS
  'Starts or resumes the authenticated student exam; named arguments are part of the PostgREST API contract.';
COMMENT ON FUNCTION public.submit_exam(uuid, jsonb) IS
  'Idempotently submits the authenticated student exam; named arguments are part of the PostgREST API contract.';
COMMENT ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) IS
  'Optimistically saves authenticated student progress; named arguments are part of the PostgREST API contract.';
COMMENT ON FUNCTION public.terminate_exam(uuid) IS
  'Terminates and finalizes the authenticated student exam; named arguments are part of the PostgREST API contract.';

COMMIT;
