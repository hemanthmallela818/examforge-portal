-- =====================================================================
-- Stage 20 — Close the pre-exam question pre-disclosure hole (BLOCKER B-3)
-- =====================================================================
--
-- WHAT WAS WRONG
-- --------------
-- Migration 20260910090000_deep_exam_data_validation.sql (line 500) issued a
-- TABLE-WIDE grant:  GRANT SELECT ON public.cbt_exams_raw TO authenticated.
-- Row-Level Security (policy `cbt_exams_read_assigned`, last set in
-- 20260910190000) restricts WHICH ROWS an authenticated student may read, but
-- RLS does not restrict WHICH COLUMNS. PostgREST exposes every base table
-- directly, so an assigned student could issue:
--
--     GET /rest/v1/cbt_exams_raw?select=questions_data&id=eq.<examId>
--
-- and receive the exam's full `questions_data` (the entire question paper —
-- only the answer key itself lives separately in cbt_exam_answers) BEFORE the
-- exam is ACTIVE, un-randomised, and without ever calling start_exam_session().
-- This bypasses the answer-safe `public.cbt_exams` view (which strips the
-- `questions` key for non-admins) and the server-owned randomised-paper path.
--
-- THE FIX (three parts; fully reversible — see the ROLLBACK block at the end)
-- --------------------------------------------------------------------------
--   A. Replace the table-wide SELECT grant with a COLUMN-LEVEL grant that
--      EXCLUDES `questions_data`. Students keep read access to exam metadata
--      (id/title/status/class/section/created_at) — all the dashboard, the
--      pre-exam status poll, and Realtime status updates need — but can no
--      longer select `questions_data` directly. Realtime keeps working: a
--      column-level grant still satisfies has_table_privilege(), and Realtime
--      omits columns the subscriber lacks column privilege on (so
--      `questions_data` is simply dropped from the change payload).
--
--   B. Add a SECURITY DEFINER "manifest" function, exam_questions_for_viewer(),
--      returning the correct questions_data for the current caller:
--        * Admin-AAL2       -> full reconstructed paper (answers re-injected)
--        * assigned student -> questions_data with the `questions` key stripped
--        * anyone else      -> NULL
--      Because `public.cbt_exams` is a security_invoker view, once the column
--      grant is removed the view can no longer read r.questions_data AS THE
--      STUDENT. Sourcing questions_data through a SECURITY DEFINER function lets
--      the view keep working WITHOUT granting students column access to the
--      answer-bearing base data. The function re-checks the SAME assignment
--      predicate as the RLS policy, so it is no more permissive than direct
--      row access and is safe to expose as a PostgREST RPC.
--
--   C. Redefine `public.cbt_exams` to source questions_data from the function.
--      The 7 output columns (names, order, types) are unchanged, so the
--      INSTEAD OF trigger (handle_cbt_exams_modification) that powers the admin
--      write path stays attached and the admin edit/insert flow is preserved.
--
-- SCOPE / SAFETY
-- --------------
--   * Only SELECT privileges on the base table and the view definition change.
--     INSERT/UPDATE/DELETE were already revoked from authenticated
--     (20260910090000:498) and the write path runs through the SECURITY DEFINER
--     INSTEAD OF trigger, so admin writes are unaffected.
--   * The RLS policy cbt_exams_read_assigned is intentionally left untouched;
--     it still gates row visibility for the security_invoker view.
--
-- >>> Apply to STAGING first and run the B-3 validation checklist
-- >>> (docs/B3_MIGRATION_RUNBOOK.md, mirrored in PRODUCTION_READINESS_PLAN.md
-- >>> §10.4) before promoting to production. A rollback block is at the bottom.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Part A — Column-level SELECT grant (excludes questions_data)
-- ---------------------------------------------------------------------
-- Drop the blanket grant, then re-grant only the safe metadata columns.
-- (REVOKE of a privilege a role does not hold is a harmless no-op.)
REVOKE SELECT ON public.cbt_exams_raw FROM authenticated;
REVOKE SELECT ON public.cbt_exams_raw FROM anon;

GRANT SELECT (id, title, status, class, section, created_at)
  ON public.cbt_exams_raw TO authenticated;

-- ---------------------------------------------------------------------
-- Part B — SECURITY DEFINER manifest for questions_data
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.exam_questions_for_viewer(p_exam_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_qdata   jsonb;
  v_answers jsonb;
  v_class   text;
  v_section text;
BEGIN
  SELECT r.questions_data, a.answers, r.class, r.section
    INTO v_qdata, v_answers, v_class, v_section
  FROM public.cbt_exams_raw r
  LEFT JOIN public.cbt_exam_answers a ON a.exam_id = r.id
  WHERE r.id = p_exam_id;

  -- No such exam, or an exam with no stored paper.
  IF NOT FOUND OR v_qdata IS NULL THEN
    RETURN NULL;
  END IF;

  -- Admins with a verified MFA (AAL2) session get the full reconstructed
  -- paper (answers re-injected), exactly as the previous view CASE branch did.
  IF public.is_admin_aal2() THEN
    RETURN public.reconstruct_exam_questions(v_qdata, v_answers);
  END IF;

  -- Non-admins: only assigned, non-archived students may see the metadata,
  -- and NEVER the `questions` array. This predicate is a faithful mirror of
  -- the cbt_exams_read_assigned RLS policy (20260910190000) so this function
  -- is no more permissive than direct row access to the base table, and is
  -- therefore safe to expose directly as a PostgREST RPC.
  IF NOT EXISTS (
    SELECT 1 FROM public.students s
    WHERE s.id = auth.uid()
      AND s.archived_at IS NULL
      AND (v_class IS NULL OR v_class = 'All' OR s.class = v_class)
      AND (v_section IS NULL OR v_section = 'All' OR s.section = v_section)
  ) THEN
    RETURN NULL;
  END IF;

  -- Strip the questions array: students receive exam metadata only (subjects,
  -- marks, duration, ...), never the questions themselves. The ONLY path to
  -- the questions remains start_exam_session() after a legitimate start.
  RETURN v_qdata - 'questions';
END;
$$;

REVOKE ALL ON FUNCTION public.exam_questions_for_viewer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.exam_questions_for_viewer(uuid) TO authenticated;

COMMENT ON FUNCTION public.exam_questions_for_viewer(uuid) IS
  'B-3 manifest: returns questions_data for the answer-safe cbt_exams view '
  'without granting authenticated column access to cbt_exams_raw.questions_data. '
  'Admin-AAL2 -> reconstructed paper; assigned student -> questions_data minus '
  'the questions key; otherwise NULL. Mirrors the cbt_exams_read_assigned RLS '
  'predicate so it is safe to expose as an RPC.';

-- ---------------------------------------------------------------------
-- Part C — Redefine the answer-safe view to source questions_data via the
--          manifest function. Same 7 columns / order / types, so the
--          INSTEAD OF write trigger and every client read keep working.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW public.cbt_exams WITH (security_invoker = true) AS
SELECT
  r.id,
  r.title,
  r.status,
  r.class,
  r.section,
  r.created_at,
  public.exam_questions_for_viewer(r.id) AS questions_data
FROM public.cbt_exams_raw r;

COMMIT;

-- =====================================================================
-- ROLLBACK  (run ONLY if staging validation fails; restores prior state)
-- =====================================================================
-- BEGIN;
--   -- 1. Restore the view to its 20260910160000 definition (drops the
--   --    dependency on exam_questions_for_viewer first).
--   CREATE OR REPLACE VIEW public.cbt_exams WITH (security_invoker = true) AS
--   SELECT r.id, r.title, r.status, r.class, r.section, r.created_at,
--     CASE
--       WHEN public.is_admin_aal2()
--         THEN public.reconstruct_exam_questions(r.questions_data, a.answers)
--       ELSE r.questions_data - 'questions'
--     END AS questions_data
--   FROM public.cbt_exams_raw r
--   LEFT JOIN public.cbt_exam_answers a ON r.id = a.exam_id;
--
--   -- 2. Restore the (over-broad) table-wide SELECT grant.
--   REVOKE SELECT (id, title, status, class, section, created_at)
--     ON public.cbt_exams_raw FROM authenticated;
--   GRANT SELECT ON public.cbt_exams_raw TO authenticated;
--
--   -- 3. Remove the manifest function.
--   DROP FUNCTION IF EXISTS public.exam_questions_for_viewer(uuid);
-- COMMIT;
-- =====================================================================
