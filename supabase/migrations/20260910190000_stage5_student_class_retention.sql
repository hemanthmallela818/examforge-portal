-- Stage 5B: reversible student deactivation and audited empty-class deletion.

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid,
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE public.students
  DROP CONSTRAINT IF EXISTS students_archive_state_valid;
ALTER TABLE public.students
  ADD CONSTRAINT students_archive_state_valid CHECK (
    (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
    OR
    (archived_at IS NOT NULL AND archived_by IS NOT NULL
      AND length(btrim(archive_reason)) BETWEEN 3 AND 500)
  );

CREATE INDEX IF NOT EXISTS students_active_roster_idx
  ON public.students (class, section, student_id)
  WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.protect_inactive_student_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND (
    NEW.class IS DISTINCT FROM OLD.class OR NEW.section IS DISTINCT FROM OLD.section
  ) THEN
    RAISE EXCEPTION 'Inactive student assignments cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_inactive_student_assignment_trigger ON public.students;
CREATE TRIGGER protect_inactive_student_assignment_trigger
  BEFORE UPDATE OF class, section ON public.students
  FOR EACH ROW EXECUTE FUNCTION public.protect_inactive_student_assignment();
REVOKE ALL ON FUNCTION public.protect_inactive_student_assignment() FROM PUBLIC;

-- Student accounts never mutate roster or lifecycle columns directly.
REVOKE INSERT, UPDATE, DELETE ON public.students FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS students_read_own ON public.students;
CREATE POLICY students_read_own ON public.students
  FOR SELECT TO authenticated
  USING ((auth.uid() = id AND archived_at IS NULL) OR public.is_admin_aal2());

DROP POLICY IF EXISTS classes_read ON public.classes;
CREATE POLICY classes_read ON public.classes
  FOR SELECT TO authenticated
  USING (
    public.is_admin_aal2()
    OR EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = auth.uid() AND s.archived_at IS NULL
    )
  );

DROP POLICY IF EXISTS cbt_exams_read_assigned ON public.cbt_exams_raw;
CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw
  FOR SELECT TO authenticated
  USING (
    public.is_admin_aal2()
    OR EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = auth.uid()
        AND s.archived_at IS NULL
        AND (cbt_exams_raw.class IS NULL OR cbt_exams_raw.class = 'All' OR s.class = cbt_exams_raw.class)
        AND (cbt_exams_raw.section IS NULL OR cbt_exams_raw.section = 'All' OR s.section = cbt_exams_raw.section)
    )
  );

DROP POLICY IF EXISTS student_results_read_own ON public.student_results;
CREATE POLICY student_results_read_own ON public.student_results
  FOR SELECT TO authenticated
  USING (
    public.is_admin_aal2()
    OR EXISTS (
      SELECT 1 FROM public.students s
      WHERE s.id = auth.uid()
        AND s.archived_at IS NULL
        AND s.student_id = student_results.student_id
    )
  );

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
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found';
  END IF;
  IF student_row.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This student account is inactive';
  END IF;

  UPDATE public.students
  SET active_auth_session_id = claimed_session_id
  WHERE id = auth.uid();

  RETURN jsonb_build_object(
    'session_id', claimed_session_id,
    'student_id', student_row.student_id,
    'name', student_row.name,
    'class', student_row.class,
    'section', student_row.section
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_student_session() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_student_session() TO authenticated;

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
    SELECT 1 FROM public.students
    WHERE id = auth.uid()
      AND archived_at IS NULL
      AND active_auth_session_id = expected_session_id
  ) THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_current_student_session() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.admin_deactivate_students(
  user_ids_param uuid[],
  reason_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  affected_count integer := 0;
  requested_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  requested_count := cardinality(user_ids_param);
  IF requested_count IS NULL OR requested_count < 1 OR requested_count > 100 THEN
    RAISE EXCEPTION 'Select between 1 and 100 students';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(user_ids_param) AS selected(id) WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(user_ids_param) AS selected(id)) <> requested_count THEN
    RAISE EXCEPTION 'Student selection contains invalid or duplicate IDs';
  END IF;
  IF reason_param IS NULL OR length(btrim(reason_param)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deactivation reason between 3 and 500 characters is required';
  END IF;

  FOR student_row IN
    SELECT * FROM public.students
    WHERE id = ANY(user_ids_param)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF student_row.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Student % is already inactive', student_row.student_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.active_sessions a WHERE a.student_id = student_row.student_id) THEN
      RAISE EXCEPTION 'Student % has an active examination attempt and cannot be deactivated', student_row.student_id;
    END IF;

    UPDATE public.students
    SET archived_at = clock_timestamp(), archived_by = auth.uid(),
        archive_reason = btrim(reason_param), active_auth_session_id = NULL
    WHERE id = student_row.id;

    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      auth.uid(), 'DEACTIVATE_STUDENT', 'student', student_row.id::text,
      jsonb_build_object('student_id', student_row.student_id, 'name', student_row.name,
                         'reason', btrim(reason_param))
    );
    affected_count := affected_count + 1;
  END LOOP;

  IF affected_count <> requested_count THEN
    RAISE EXCEPTION 'One or more selected students were not found';
  END IF;
  RETURN jsonb_build_object('deactivated', affected_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reactivate_students(user_ids_param uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  affected_count integer := 0;
  requested_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  requested_count := cardinality(user_ids_param);
  IF requested_count IS NULL OR requested_count < 1 OR requested_count > 100 THEN
    RAISE EXCEPTION 'Select between 1 and 100 students';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(user_ids_param) AS selected(id) WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(user_ids_param) AS selected(id)) <> requested_count THEN
    RAISE EXCEPTION 'Student selection contains invalid or duplicate IDs';
  END IF;

  FOR student_row IN
    SELECT * FROM public.students
    WHERE id = ANY(user_ids_param)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF student_row.archived_at IS NULL THEN
      RAISE EXCEPTION 'Student % is already active', student_row.student_id;
    END IF;

    UPDATE public.students
    SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
        active_auth_session_id = NULL
    WHERE id = student_row.id;

    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      auth.uid(), 'REACTIVATE_STUDENT', 'student', student_row.id::text,
      jsonb_build_object('student_id', student_row.student_id, 'name', student_row.name)
    );
    affected_count := affected_count + 1;
  END LOOP;

  IF affected_count <> requested_count THEN
    RAISE EXCEPTION 'One or more selected students were not found';
  END IF;
  RETURN jsonb_build_object('reactivated', affected_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_deactivate_students(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reactivate_students(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_deactivate_students(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_students(uuid[]) TO authenticated;

-- Permanently deleting roster identities and their history is not an application operation.
REVOKE ALL ON FUNCTION public.delete_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_students(uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_empty_class(
  class_id_param uuid,
  expected_name_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  class_row public.classes%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  SELECT * INTO class_row FROM public.classes WHERE id = class_id_param FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class was not found';
  END IF;
  IF expected_name_param IS DISTINCT FROM class_row.name THEN
    RAISE EXCEPTION 'Class name confirmation did not match';
  END IF;
  IF EXISTS (SELECT 1 FROM public.students WHERE class = class_row.name) THEN
    RAISE EXCEPTION 'Cannot delete a class with active or inactive student records';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cbt_exams_raw WHERE class = class_row.name) THEN
    RAISE EXCEPTION 'Cannot delete a class referenced by an examination';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_EMPTY_CLASS', 'class', class_row.id::text,
    jsonb_build_object('name', class_row.name, 'sections', class_row.sections)
  );
  DELETE FROM public.classes WHERE id = class_row.id;
  RETURN jsonb_build_object('deleted', true, 'class_id', class_row.id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_empty_class(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_empty_class(uuid, text) TO authenticated;
REVOKE DELETE ON public.classes FROM PUBLIC, anon, authenticated;
