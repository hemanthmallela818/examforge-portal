-- Apply after 20260823000000_schema.sql.
-- This migration removes public data exposure, prevents e-mail-based admin
-- escalation, and supplies the unique key required by result upserts.

BEGIN;

ALTER TABLE public.student_results
  ADD CONSTRAINT student_results_student_exam_key UNIQUE (student_id, exam_id);

-- Security-definer helpers must use a fixed search path.
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_role text;
BEGIN
  SELECT role INTO user_role FROM public.profiles WHERE id = auth.uid();
  RETURN user_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_user(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  public_student_id text;
BEGIN
  IF public.get_my_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can delete users';
  END IF;

  SELECT student_id INTO public_student_id FROM public.students WHERE id = user_id;
  IF public_student_id IS NOT NULL THEN
    DELETE FROM public.active_sessions WHERE student_id = public_student_id;
    DELETE FROM public.student_results WHERE student_id = public_student_id;
  END IF;
  DELETE FROM auth.users WHERE id = user_id;
END;
$$;

-- New signups are always students. Administrators must be provisioned by a
-- trusted server-side process, never inferred from an e-mail address.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'student'
  ) ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name;

  INSERT INTO public.students (id, student_id, name, password, class, section)
  VALUES (
    new.id,
    COALESCE(new.raw_user_meta_data->>'student_id', split_part(new.email, '@', 1)),
    COALESCE(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'SUPABASE_AUTH',
    COALESCE(new.raw_user_meta_data->>'class', 'Class 10'),
    COALESCE(new.raw_user_meta_data->>'section', 'A')
  ) ON CONFLICT (id) DO UPDATE SET
    student_id = EXCLUDED.student_id,
    name = EXCLUDED.name,
    class = EXCLUDED.class,
    section = EXCLUDED.section;

  RETURN new;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_user(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;

-- Students may only rotate their own session token. Column privileges prevent
-- this policy from becoming permission to edit their name, class, or section.
REVOKE UPDATE ON public.students FROM anon, authenticated;
GRANT UPDATE (session_token) ON public.students TO authenticated;

DROP POLICY IF EXISTS profiles_read ON public.profiles;
DROP POLICY IF EXISTS profiles_admin ON public.profiles;
CREATE POLICY profiles_read_own ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.get_my_role() = 'admin');
CREATE POLICY profiles_admin_all ON public.profiles FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS classes_read ON public.classes;
DROP POLICY IF EXISTS classes_admin ON public.classes;
CREATE POLICY classes_admin_all ON public.classes FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS students_read ON public.students;
DROP POLICY IF EXISTS students_admin ON public.students;
DROP POLICY IF EXISTS "Allow delete to admins" ON public.students;
DROP POLICY IF EXISTS "Allow insert to all" ON public.students;
DROP POLICY IF EXISTS "Allow read to all" ON public.students;
DROP POLICY IF EXISTS "Allow update to all" ON public.students;
CREATE POLICY students_read_own ON public.students FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.get_my_role() = 'admin');
CREATE POLICY students_update_own_session ON public.students FOR UPDATE TO authenticated
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY students_admin_all ON public.students FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS cbt_exams_read ON public.cbt_exams_raw;
DROP POLICY IF EXISTS cbt_exams_admin ON public.cbt_exams_raw;
DROP POLICY IF EXISTS "Allow admin all" ON public.cbt_exams_raw;
DROP POLICY IF EXISTS "Allow read to all" ON public.cbt_exams_raw;
CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'admin'
    OR EXISTS (
      SELECT 1 FROM public.students
      WHERE id = auth.uid()
        AND class = cbt_exams_raw.class
        AND section = cbt_exams_raw.section
    )
  );
CREATE POLICY cbt_exams_admin_all ON public.cbt_exams_raw FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS student_results_read ON public.student_results;
DROP POLICY IF EXISTS student_results_insert ON public.student_results;
DROP POLICY IF EXISTS student_results_admin ON public.student_results;
DROP POLICY IF EXISTS "Allow admin all" ON public.student_results;
DROP POLICY IF EXISTS "Allow insert to all" ON public.student_results;
DROP POLICY IF EXISTS "Allow read to all" ON public.student_results;
CREATE POLICY student_results_read_own ON public.student_results FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'admin'
    OR student_id = (SELECT student_id FROM public.students WHERE id = auth.uid())
  );
CREATE POLICY student_results_insert_own ON public.student_results FOR INSERT TO authenticated
  WITH CHECK (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY student_results_update_own ON public.student_results FOR UPDATE TO authenticated
  USING (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()))
  WITH CHECK (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY student_results_admin_all ON public.student_results FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS active_sessions_read ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_write ON public.active_sessions;
DROP POLICY IF EXISTS "Allow admin all" ON public.active_sessions;
DROP POLICY IF EXISTS "Allow insert to all" ON public.active_sessions;
DROP POLICY IF EXISTS "Allow read to all" ON public.active_sessions;
DROP POLICY IF EXISTS "Allow update to all" ON public.active_sessions;
CREATE POLICY active_sessions_read_own ON public.active_sessions FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'admin'
    OR student_id = (SELECT student_id FROM public.students WHERE id = auth.uid())
  );
CREATE POLICY active_sessions_insert_own ON public.active_sessions FOR INSERT TO authenticated
  WITH CHECK (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY active_sessions_update_own ON public.active_sessions FOR UPDATE TO authenticated
  USING (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()))
  WITH CHECK (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY active_sessions_delete_own ON public.active_sessions FOR DELETE TO authenticated
  USING (student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY active_sessions_admin_all ON public.active_sessions FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS question_bank_read ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin ON public.question_bank;
CREATE POLICY question_bank_admin_all ON public.question_bank FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

DROP POLICY IF EXISTS import_history_admin ON public.import_history;
CREATE POLICY import_history_admin_all ON public.import_history FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

COMMIT;
