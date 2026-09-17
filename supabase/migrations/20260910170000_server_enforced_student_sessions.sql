-- Stage 4: server-enforced single active student authentication session.
-- The signed Supabase JWT session_id is the authority; browser-generated
-- tokens and Realtime notifications are UX signals only.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS active_auth_session_id uuid;

COMMENT ON COLUMN public.students.active_auth_session_id IS
  'Supabase Auth JWT session_id currently authorized for student exam operations.';

-- Candidates may no longer rotate takeover state by directly updating the row.
REVOKE UPDATE (session_token) ON public.students FROM authenticated;
DROP POLICY IF EXISTS students_update_own_session ON public.students;
ALTER TABLE public.students DROP COLUMN IF EXISTS session_token;

CREATE OR REPLACE FUNCTION public.current_auth_session_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  raw_session_id text;
BEGIN
  raw_session_id := NULLIF(auth.jwt()->>'session_id', '');
  IF raw_session_id IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN raw_session_id::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.current_auth_session_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_auth_session_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_student_session()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  claimed_session_id uuid;
  student_row public.students%ROWTYPE;
BEGIN
  claimed_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR claimed_session_id IS NULL THEN
    RAISE EXCEPTION 'A valid authenticated Supabase session is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':student-session-claim', 0));
  UPDATE public.students
  SET active_auth_session_id = claimed_session_id
  WHERE id = auth.uid()
  RETURNING * INTO student_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found';
  END IF;

  RETURN jsonb_build_object(
    'session_id', claimed_session_id,
    'student_id', student_row.student_id,
    'name', student_row.name,
    'class', student_row.class,
    'section', student_row.section
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_student_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_student_session() TO authenticated;

CREATE OR REPLACE FUNCTION public.release_student_session()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  released_count integer;
BEGIN
  IF auth.uid() IS NULL OR public.current_auth_session_id() IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.students
  SET active_auth_session_id = NULL
  WHERE id = auth.uid()
    AND active_auth_session_id = public.current_auth_session_id();
  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_student_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_student_session() TO authenticated;

CREATE OR REPLACE FUNCTION public.assert_current_student_session()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_session_id uuid;
BEGIN
  expected_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR expected_session_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.students
    WHERE id = auth.uid()
      AND active_auth_session_id = expected_session_id
  ) THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_current_student_session() FROM PUBLIC;

-- Existing Stage 3 functions become private implementations. Public wrappers
-- enforce the signed session claim before any exam operation runs.
ALTER FUNCTION public.start_exam_session(uuid, jsonb, jsonb)
  RENAME TO start_exam_session_stage3_internal;
REVOKE ALL ON FUNCTION public.start_exam_session_stage3_internal(uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.start_exam_session(uuid, jsonb, jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_current_student_session();
  RETURN public.start_exam_session_stage3_internal($1, $2, $3);
END;
$$;
REVOKE ALL ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) TO authenticated;

ALTER FUNCTION public.sync_active_session_progress(uuid, jsonb, integer)
  RENAME TO sync_active_session_progress_stage3_internal;
REVOKE ALL ON FUNCTION public.sync_active_session_progress_stage3_internal(uuid, jsonb, integer)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.sync_active_session_progress(uuid, jsonb, integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_current_student_session();
  RETURN public.sync_active_session_progress_stage3_internal($1, $2, $3);
END;
$$;
REVOKE ALL ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) TO authenticated;

ALTER FUNCTION public.submit_exam(uuid, jsonb)
  RENAME TO submit_exam_stage3_internal;
REVOKE ALL ON FUNCTION public.submit_exam_stage3_internal(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.submit_exam(uuid, jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_current_student_session();
  RETURN public.submit_exam_stage3_internal($1, $2);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_exam(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb) TO authenticated;

ALTER FUNCTION public.terminate_exam(uuid)
  RENAME TO terminate_exam_stage3_internal;
REVOKE ALL ON FUNCTION public.terminate_exam_stage3_internal(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.terminate_exam(uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.assert_current_student_session();
  PERFORM public.terminate_exam_stage3_internal($1);
END;
$$;
REVOKE ALL ON FUNCTION public.terminate_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid) TO authenticated;

-- Old devices cannot read the full in-progress paper or answer state directly.
DROP POLICY IF EXISTS active_sessions_select_own ON public.active_sessions;
CREATE POLICY active_sessions_select_own ON public.active_sessions
  FOR SELECT TO authenticated
  USING (
    public.is_admin_aal2()
    OR EXISTS (
      SELECT 1
      FROM public.students AS student
      WHERE student.id = auth.uid()
        AND student.student_id = active_sessions.student_id
        AND student.active_auth_session_id = public.current_auth_session_id()
    )
  );

-- Private question images follow the same active-session boundary.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    DROP POLICY IF EXISTS exam_assets_read ON storage.objects;
    CREATE POLICY exam_assets_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'exam-assets'
        AND (
          public.is_admin_aal2()
          OR EXISTS (
            SELECT 1
            FROM public.students AS student
            JOIN public.active_sessions AS attempt
              ON attempt.student_id = student.student_id
            WHERE student.id = auth.uid()
              AND student.active_auth_session_id = public.current_auth_session_id()
              AND jsonb_path_exists(
                attempt.jumbled_exam_data,
                '$.** ? (@ == $asset)',
                jsonb_build_object('asset', storage.objects.name)
              )
          )
        )
      );
  END IF;
END;
$$;
