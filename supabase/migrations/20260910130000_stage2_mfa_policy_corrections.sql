-- Migration: 20260910130000_stage2_mfa_policy_corrections.sql
-- Description: Complete Stage 2 RLS policy cleanup and active-session boundary restoration.
-- Explicitly drops all legacy AAL1 policies and ensures is_admin_aal2() is strictly required for all administrative branches.

-- ============================================================================
-- 1. DROP ALL OBSOLETE AAL1 POLICIES ACROSS ALL TABLES
-- ============================================================================

-- PROFILES
DROP POLICY IF EXISTS profiles_read ON public.profiles;
DROP POLICY IF EXISTS profiles_read_own ON public.profiles;
DROP POLICY IF EXISTS profiles_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_all ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_aal2 ON public.profiles;

-- CLASSES
DROP POLICY IF EXISTS classes_read ON public.classes;
DROP POLICY IF EXISTS classes_admin ON public.classes;
DROP POLICY IF EXISTS classes_admin_all ON public.classes;
DROP POLICY IF EXISTS classes_admin_aal2 ON public.classes;

-- STUDENTS
DROP POLICY IF EXISTS students_read ON public.students;
DROP POLICY IF EXISTS students_read_own ON public.students;
DROP POLICY IF EXISTS students_admin ON public.students;
DROP POLICY IF EXISTS students_admin_all ON public.students;
DROP POLICY IF EXISTS students_update_own_session ON public.students;
DROP POLICY IF EXISTS students_admin_aal2 ON public.students;

-- CBT_EXAMS_RAW
DROP POLICY IF EXISTS cbt_exams_read_assigned ON public.cbt_exams_raw;
DROP POLICY IF EXISTS cbt_exams_admin_all ON public.cbt_exams_raw;
DROP POLICY IF EXISTS cbt_exams_admin ON public.cbt_exams_raw;
DROP POLICY IF EXISTS "Allow admin all" ON public.cbt_exams_raw;

-- CBT_EXAM_ANSWERS
DROP POLICY IF EXISTS cbt_exam_answers_admin_only ON public.cbt_exam_answers;
DROP POLICY IF EXISTS cbt_exam_answers_admin_select ON public.cbt_exam_answers;

-- STUDENT_RESULTS
DROP POLICY IF EXISTS student_results_read ON public.student_results;
DROP POLICY IF EXISTS student_results_read_own ON public.student_results;
DROP POLICY IF EXISTS student_results_admin ON public.student_results;
DROP POLICY IF EXISTS student_results_admin_all ON public.student_results;
DROP POLICY IF EXISTS student_results_admin_aal2 ON public.student_results;
DROP POLICY IF EXISTS student_results_insert ON public.student_results;
DROP POLICY IF EXISTS student_results_insert_own ON public.student_results;
DROP POLICY IF EXISTS student_results_update_own ON public.student_results;

-- ACTIVE_SESSIONS
DROP POLICY IF EXISTS active_sessions_read ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_write ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_read_own ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_admin_all ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_update_progress ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_select_own ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_admin_insert ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_admin_delete ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_insert_own ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_delete_own ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_update_own ON public.active_sessions;

-- QUESTION_BANK
DROP POLICY IF EXISTS question_bank_read ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin_all ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin_select ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin_aal2 ON public.question_bank;

-- IMPORT_HISTORY
DROP POLICY IF EXISTS import_history_admin ON public.import_history;
DROP POLICY IF EXISTS import_history_admin_all ON public.import_history;
DROP POLICY IF EXISTS import_history_admin_aal2 ON public.import_history;

-- STORAGE.OBJECTS
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_read ON storage.objects;';
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_insert ON storage.objects;';
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_update ON storage.objects;';
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_delete ON storage.objects;';
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_admin_insert ON storage.objects;';
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_admin_update ON storage.objects;';
    EXECUTE 'DROP POLICY IF EXISTS exam_assets_admin_delete ON storage.objects;';
  END IF;
END;
$$;


-- ============================================================================
-- 2. CREATE STRICT AAL2 POLICIES PRESERVING STUDENT-OWN ACCESS
-- ============================================================================

-- PROFILES
CREATE POLICY profiles_read_own ON public.profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin_aal2());

CREATE POLICY profiles_admin_aal2 ON public.profiles
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- CLASSES
CREATE POLICY classes_read ON public.classes
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY classes_admin_aal2 ON public.classes
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- STUDENTS
CREATE POLICY students_read_own ON public.students
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin_aal2());

CREATE POLICY students_update_own_session ON public.students
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY students_admin_aal2 ON public.students
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- CBT_EXAMS_RAW: assigned read only, mutations blocked via triggers & privileges
CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw
  FOR SELECT TO authenticated
  USING (
    public.is_admin_aal2()
    OR EXISTS (
      SELECT 1
      FROM public.students s
      WHERE s.id = auth.uid()
        AND (cbt_exams_raw.class IS NULL OR cbt_exams_raw.class = 'All' OR s.class = cbt_exams_raw.class)
        AND (cbt_exams_raw.section IS NULL OR cbt_exams_raw.section = 'All' OR s.section = cbt_exams_raw.section)
    )
  );

-- CBT_EXAM_ANSWERS
CREATE POLICY cbt_exam_answers_admin_select ON public.cbt_exam_answers
  FOR SELECT TO authenticated
  USING (public.is_admin_aal2());

-- STUDENT_RESULTS: candidate read own, admin AAL2 read/write, no candidate direct insert/update
CREATE POLICY student_results_read_own ON public.student_results
  FOR SELECT TO authenticated
  USING (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  );

CREATE POLICY student_results_admin_aal2 ON public.student_results
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- ACTIVE_SESSIONS: Operation-specific policies restoring Stage 1 security boundary
-- 1) Candidate may only select their own active session
CREATE POLICY active_sessions_select_own ON public.active_sessions
  FOR SELECT TO authenticated
  USING (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  );

-- 2) Candidate may only update progress on their own active session (further bounded by column grants)
CREATE POLICY active_sessions_update_progress ON public.active_sessions
  FOR UPDATE TO authenticated
  USING (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  )
  WITH CHECK (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  );

-- 3) Direct INSERT allowed only for AAL2 admins (candidates must use start_exam_session)
CREATE POLICY active_sessions_admin_insert ON public.active_sessions
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_aal2());

-- 4) Direct DELETE allowed only for AAL2 admins (candidates cannot delete sessions)
CREATE POLICY active_sessions_admin_delete ON public.active_sessions
  FOR DELETE TO authenticated
  USING (public.is_admin_aal2());

-- Ensure column privileges on active_sessions: candidates can only update response and timestamp
REVOKE ALL ON public.active_sessions FROM anon;
REVOKE ALL ON public.active_sessions FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.active_sessions TO authenticated;
GRANT UPDATE (user_responses, updated_at) ON public.active_sessions TO authenticated;

-- QUESTION_BANK
CREATE POLICY question_bank_admin_select ON public.question_bank
  FOR SELECT TO authenticated
  USING (public.is_admin_aal2());

CREATE POLICY question_bank_admin_aal2 ON public.question_bank
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- IMPORT_HISTORY
CREATE POLICY import_history_admin_aal2 ON public.import_history
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- STORAGE.OBJECTS: exam-assets bucket
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
    EXECUTE $stor$
      CREATE POLICY exam_assets_read ON storage.objects
        FOR SELECT TO authenticated
        USING (
          bucket_id = 'exam-assets'
          AND (
            public.is_admin_aal2()
            OR EXISTS (SELECT 1 FROM public.students s WHERE s.id = auth.uid())
          )
        );

      CREATE POLICY exam_assets_admin_insert_aal2 ON storage.objects
        FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'exam-assets' AND public.is_admin_aal2());

      CREATE POLICY exam_assets_admin_update_aal2 ON storage.objects
        FOR UPDATE TO authenticated
        USING (bucket_id = 'exam-assets' AND public.is_admin_aal2())
        WITH CHECK (bucket_id = 'exam-assets' AND public.is_admin_aal2());

      CREATE POLICY exam_assets_admin_delete_aal2 ON storage.objects
        FOR DELETE TO authenticated
        USING (bucket_id = 'exam-assets' AND public.is_admin_aal2());
    $stor$;
  END IF;
END;
$$;


-- ============================================================================
-- 3. HARDEN ADMINISTRATIVE SECURITY DEFINER FUNCTIONS
-- ============================================================================

-- get_db_size must require AAL2 MFA
CREATE OR REPLACE FUNCTION public.get_db_size()
RETURNS TABLE(table_name text, size_bytes bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  RETURN QUERY
  SELECT c.relname::text, pg_total_relation_size(c.oid)::bigint
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname;
END;
$$;

REVOKE ALL ON FUNCTION public.get_db_size() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_db_size() TO authenticated, service_role;
