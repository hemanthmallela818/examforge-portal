-- Stage 27: keep the existing authorization model while removing avoidable
-- per-row auth function evaluation and overlapping permissive policies.

DROP POLICY IF EXISTS profiles_read_own ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_aal2 ON public.profiles;
CREATE POLICY profiles_read_own ON public.profiles
  FOR SELECT TO authenticated
  USING (id OPERATOR(pg_catalog.=) (SELECT auth.uid()) OR (SELECT public.is_admin_aal2()));
CREATE POLICY profiles_admin_insert ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY profiles_admin_update ON public.profiles
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin_aal2()))
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY profiles_admin_delete ON public.profiles
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin_aal2()));

DROP POLICY IF EXISTS classes_read ON public.classes;
DROP POLICY IF EXISTS classes_admin_aal2 ON public.classes;
CREATE POLICY classes_read ON public.classes
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin_aal2())
    OR EXISTS (
      SELECT 1
      FROM public.students AS s
      WHERE s.id OPERATOR(pg_catalog.=) (SELECT auth.uid())
        AND s.archived_at IS NULL
    )
  );
CREATE POLICY classes_admin_insert ON public.classes
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY classes_admin_update ON public.classes
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin_aal2()))
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY classes_admin_delete ON public.classes
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin_aal2()));

DROP POLICY IF EXISTS students_read_own ON public.students;
DROP POLICY IF EXISTS students_admin_aal2 ON public.students;
CREATE POLICY students_read_own ON public.students
  FOR SELECT TO authenticated
  USING (
    (id OPERATOR(pg_catalog.=) (SELECT auth.uid()) AND archived_at IS NULL)
    OR (SELECT public.is_admin_aal2())
  );
CREATE POLICY students_admin_insert ON public.students
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY students_admin_update ON public.students
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin_aal2()))
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY students_admin_delete ON public.students
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin_aal2()));

DROP POLICY IF EXISTS question_bank_admin_select ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin_aal2 ON public.question_bank;
CREATE POLICY question_bank_admin_select ON public.question_bank
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin_aal2()));
CREATE POLICY question_bank_admin_insert ON public.question_bank
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY question_bank_admin_update ON public.question_bank
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin_aal2()))
  WITH CHECK ((SELECT public.is_admin_aal2()));
CREATE POLICY question_bank_admin_delete ON public.question_bank
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin_aal2()));

DROP POLICY IF EXISTS cbt_exams_read_assigned ON public.cbt_exams_raw;
CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin_aal2())
    OR EXISTS (
      SELECT 1
      FROM public.students AS s
      WHERE s.id OPERATOR(pg_catalog.=) (SELECT auth.uid())
        AND s.archived_at IS NULL
        AND (cbt_exams_raw.class IS NULL OR cbt_exams_raw.class OPERATOR(pg_catalog.=) 'All' OR s.class OPERATOR(pg_catalog.=) cbt_exams_raw.class)
        AND (cbt_exams_raw.section IS NULL OR cbt_exams_raw.section OPERATOR(pg_catalog.=) 'All' OR s.section OPERATOR(pg_catalog.=) cbt_exams_raw.section)
    )
  );

DROP POLICY IF EXISTS student_results_read_own ON public.student_results;
CREATE POLICY student_results_read_own ON public.student_results
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin_aal2())
    OR EXISTS (
      SELECT 1
      FROM public.students AS s
      WHERE s.id OPERATOR(pg_catalog.=) (SELECT auth.uid())
        AND s.archived_at IS NULL
        AND s.student_id OPERATOR(pg_catalog.=) student_results.student_id
    )
  );

DROP POLICY IF EXISTS active_sessions_select_own ON public.active_sessions;
CREATE POLICY active_sessions_select_own ON public.active_sessions
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin_aal2())
    OR EXISTS (
      SELECT 1
      FROM public.students AS student
      WHERE student.id OPERATOR(pg_catalog.=) (SELECT auth.uid())
        AND student.student_id OPERATOR(pg_catalog.=) active_sessions.student_id
        AND student.active_auth_session_id OPERATOR(pg_catalog.=) (SELECT public.current_auth_session_id())
    )
  );

DROP POLICY IF EXISTS exam_status_events_read_assigned ON public.exam_status_events;
CREATE POLICY exam_status_events_read_assigned ON public.exam_status_events
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_admin_aal2())
    OR EXISTS (
      SELECT 1
      FROM public.students AS s
      WHERE s.id OPERATOR(pg_catalog.=) (SELECT auth.uid())
        AND s.archived_at IS NULL
        AND (exam_status_events.class IS NULL OR exam_status_events.class OPERATOR(pg_catalog.=) 'All' OR exam_status_events.class OPERATOR(pg_catalog.=) s.class)
        AND (exam_status_events.section IS NULL OR exam_status_events.section OPERATOR(pg_catalog.=) 'All' OR exam_status_events.section OPERATOR(pg_catalog.=) s.section)
    )
  );
