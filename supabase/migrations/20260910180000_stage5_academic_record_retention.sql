-- Stage 5A: immutable academic results and audited deletion of unused exams.
-- Submitted results are institutional records and are never deleted by the web app.

CREATE TABLE IF NOT EXISTS public.admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  target_type text NOT NULL CHECK (length(target_type) BETWEEN 1 AND 80),
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.admin_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_audit_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.admin_audit_events TO authenticated;

DROP POLICY IF EXISTS admin_audit_events_read_aal2 ON public.admin_audit_events;
CREATE POLICY admin_audit_events_read_aal2 ON public.admin_audit_events
  FOR SELECT TO authenticated
  USING (public.is_admin_aal2());

-- Result rows can be created only by the protected submission/termination RPCs.
-- Neither candidates nor administrators can edit or erase the committed record.
DROP POLICY IF EXISTS student_results_admin_aal2 ON public.student_results;
REVOKE INSERT, UPDATE, DELETE ON public.student_results FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.protect_committed_student_results()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_setting('cbt.trusted_result_retention', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Committed examination results are immutable and cannot be updated or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_committed_student_results_trigger ON public.student_results;
CREATE TRIGGER protect_committed_student_results_trigger
  BEFORE UPDATE OR DELETE ON public.student_results
  FOR EACH ROW EXECUTE FUNCTION public.protect_committed_student_results();

REVOKE ALL ON FUNCTION public.protect_committed_student_results() FROM PUBLIC;

-- Delete only an exam that has never been attempted. The exact title is an
-- optimistic confirmation token, protecting against stale or wrong UI state.
CREATE OR REPLACE FUNCTION public.admin_delete_unused_exam(
  exam_id_param uuid,
  expected_title_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
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
  IF exam_row.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'Cannot delete an active exam. End the exam first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = exam_id_param::text) THEN
    RAISE EXCEPTION 'Cannot delete an exam with submitted results';
  END IF;
  IF EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = exam_id_param::text) THEN
    RAISE EXCEPTION 'Cannot delete an exam with student attempts';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_UNUSED_EXAM', 'cbt_exam', exam_id_param::text,
    jsonb_build_object('title', exam_row.title, 'status', exam_row.status)
  );

  PERFORM set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  DELETE FROM public.cbt_exams_raw WHERE id = exam_id_param;

  RETURN jsonb_build_object('deleted', true, 'exam_id', exam_id_param);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_unused_exam(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_unused_exam(uuid, text) TO authenticated;

-- All browser deletion of exams must use the audited function above.
REVOKE DELETE ON public.cbt_exams FROM PUBLIC, anon, authenticated;
