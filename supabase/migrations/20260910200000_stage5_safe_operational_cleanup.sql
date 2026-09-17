-- Stage 5C: safe operational cleanup.
-- Expired attempts are finalized, question deletion is audited, and import
-- history is retained. No browser operation may discard recoverable attempts.

DROP POLICY IF EXISTS active_sessions_admin_delete ON public.active_sessions;
REVOKE DELETE ON public.active_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_finalize_expired_sessions(batch_limit_param integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  actor_id uuid := auth.uid();
  previous_sub text := current_setting('request.jwt.claim.sub', true);
  session_row public.active_sessions%ROWTYPE;
  student_user_id uuid;
  finalized_count integer := 0;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF batch_limit_param IS NULL OR batch_limit_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Batch limit must be between 1 and 500';
  END IF;

  FOR session_row IN
    SELECT * FROM public.active_sessions
    WHERE deadline_at IS NOT NULL AND deadline_at <= clock_timestamp()
    ORDER BY deadline_at, id
    LIMIT batch_limit_param
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT id INTO student_user_id
    FROM public.students
    WHERE student_id = session_row.student_id AND archived_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expired session % has no active student record', session_row.id;
    END IF;

    -- Reuse the same private, server-authoritative grader as candidate timeout.
    -- Only the local transaction claim is changed and it is restored immediately.
    PERFORM set_config('request.jwt.claim.sub', student_user_id::text, true);
    PERFORM public.submit_exam_stage3_internal(session_row.exam_id::uuid, '[]'::jsonb);
    DELETE FROM public.active_sessions WHERE id = session_row.id;
    PERFORM set_config('request.jwt.claim.sub', COALESCE(previous_sub, actor_id::text), true);

    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      actor_id, 'FINALIZE_EXPIRED_SESSION', 'active_session', session_row.id,
      jsonb_build_object('student_id', session_row.student_id,
                         'exam_id', session_row.exam_id,
                         'deadline_at', session_row.deadline_at)
    );
    finalized_count := finalized_count + 1;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub', COALESCE(previous_sub, actor_id::text), true);
  RETURN jsonb_build_object('finalized', finalized_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_finalize_expired_sessions(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_expired_sessions(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_delete_question(question_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  question_row public.question_bank%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  SELECT * INTO question_row FROM public.question_bank
  WHERE id = question_id_param FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question was not found';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_QUESTION', 'question_bank', question_row.id::text,
    jsonb_build_object('subject', question_row.subject, 'type', question_row.type)
  );
  DELETE FROM public.question_bank WHERE id = question_row.id;
  RETURN jsonb_build_object('deleted', true, 'question_id', question_row.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_clear_question_bank(confirmation_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR QUESTION BANK' THEN
    RAISE EXCEPTION 'Exact question-bank confirmation is required';
  END IF;

  LOCK TABLE public.question_bank IN EXCLUSIVE MODE;
  SELECT count(*)::integer INTO deleted_count FROM public.question_bank;
  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'CLEAR_QUESTION_BANK', 'question_bank', NULL,
    jsonb_build_object('deleted_count', deleted_count,
                       'asset_disposition', 'retained_for_exam_snapshot_safety')
  );
  DELETE FROM public.question_bank;
  RETURN jsonb_build_object('deleted', deleted_count);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_question(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_clear_question_bank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_question(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_question_bank(text) TO authenticated;
REVOKE DELETE ON public.question_bank FROM PUBLIC, anon, authenticated;

-- Import history is itself operational audit history. It may be inserted and
-- viewed by AAL2 administrators but not rewritten or erased by the web app.
DROP POLICY IF EXISTS import_history_admin_aal2 ON public.import_history;
CREATE POLICY import_history_admin_read_aal2 ON public.import_history
  FOR SELECT TO authenticated USING (public.is_admin_aal2());
CREATE POLICY import_history_admin_insert_aal2 ON public.import_history
  FOR INSERT TO authenticated WITH CHECK (public.is_admin_aal2());
REVOKE UPDATE, DELETE ON public.import_history FROM PUBLIC, anon, authenticated;
