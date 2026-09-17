-- ============================================================================
-- Migration 20260910120000: Server-Enforced Administrator MFA (AAL2) Security
-- Enforces mandatory TOTP Multi-Factor Authentication (AAL2) for all administrator
-- operations, RLS administrative policies, storage management, and destructive RPCs.
-- Students are not affected and retain full access to their student operations.
-- ============================================================================

-- 1. Helper Function: public.is_admin_aal2()
-- Verifies that the authenticated caller has role 'admin' in profiles AND
-- has reached assurance level 'aal2' (TOTP verified) in their verified JWT.
-- Explicitly allows service_role for trusted server/bootstrap operations.
CREATE OR REPLACE FUNCTION public.is_admin_aal2()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_aal text;
  v_jwt jsonb;
BEGIN
  -- Explicit service_role bypass for trusted background/bootstrap operations
  IF auth.role() = 'service_role' THEN
    RETURN true;
  END IF;

  -- Caller must be authenticated
  IF auth.role() <> 'authenticated' OR auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  -- Verify server-owned profile role is admin
  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = auth.uid();

  IF v_role IS DISTINCT FROM 'admin' THEN
    RETURN false;
  END IF;

  -- Extract AAL claim from JWT
  -- Supports auth.jwt() and testing environments using request.jwt.claim.aal
  BEGIN
    v_jwt := auth.jwt();
  EXCEPTION WHEN OTHERS THEN
    v_jwt := NULL;
  END;

  v_aal := COALESCE(
    v_jwt ->> 'aal',
    nullif(current_setting('request.jwt.claim.aal', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal'
  );

  -- Only grant administrative access when AAL2 (MFA verified) is active
  IF v_aal = 'aal2' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_admin_aal2() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_aal2() TO authenticated, service_role;

-- 2. Update Administrator SECURITY DEFINER Functions
-- A. handle_cbt_exams_modification
CREATE OR REPLACE FUNCTION public.handle_cbt_exams_modification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clean_questions jsonb := '{}'::jsonb;
  answers_obj jsonb := '{}'::jsonb;
  subject_name text;
  question_obj jsonb;
  clean_subject_questions jsonb;
  clean_qdata jsonb;
  ans_val text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to modify exams';
  END IF;

  -- Set trusted context flag for this transaction
  PERFORM set_config('cbt.trusted_exam_context', 'on', true);

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- Deep validation of the complete paper before writing anything
    PERFORM public.validate_full_exam_paper(NEW.title, NEW.questions_data);

    -- Separate answer keys cleanly
    FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
      clean_subject_questions := '[]'::jsonb;
      FOR question_obj IN SELECT jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
        ans_val := btrim(COALESCE(question_obj->>'correctAnswer', question_obj->>'correct_answer', ''));
        IF upper(ans_val) IN ('A', 'B', 'C', 'D') THEN
          ans_val := (ascii(upper(ans_val)) - 65)::text;
        END IF;

        answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object(
          'correct_answer', ans_val,
          'subject', subject_name,
          'type', upper(COALESCE(question_obj->>'type', 'MCQ'))
        ), true);

        clean_subject_questions := clean_subject_questions || (question_obj - 'correctAnswer' - 'correct_answer');
      END LOOP;
      clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
    END LOOP;

    clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);

    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, COALESCE(NEW.status, 'PENDING'), clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, now()));
    ELSE
      UPDATE public.cbt_exams_raw
      SET title = NEW.title, status = NEW.status, questions_data = clean_qdata,
          class = NEW.class, section = NEW.section, created_at = NEW.created_at
      WHERE id = NEW.id;
    END IF;

    INSERT INTO public.cbt_exam_answers (exam_id, answers)
    VALUES (NEW.id, answers_obj)
    ON CONFLICT (exam_id) DO UPDATE SET answers = EXCLUDED.answers;

    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    DELETE FROM public.cbt_exams_raw WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

-- B. delete_user
CREATE OR REPLACE FUNCTION public.delete_user(user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  public_student_id text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to delete users';
  END IF;

  SELECT student_id INTO public_student_id FROM public.students WHERE id = user_id;
  IF public_student_id IS NOT NULL THEN
    DELETE FROM public.active_sessions WHERE student_id = public_student_id;
    DELETE FROM public.student_results WHERE student_id = public_student_id;
  END IF;
  DELETE FROM auth.users WHERE id = user_id;
END;
$$;

-- C. delete_students
CREATE OR REPLACE FUNCTION public.delete_students(user_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_id uuid;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to delete students';
  END IF;

  FOREACH user_id IN ARRAY COALESCE(user_ids, ARRAY[]::uuid[]) LOOP
    PERFORM public.delete_user(user_id);
  END LOOP;
END;
$$;

-- 3. Update Row-Level Security Policies to Enforce is_admin_aal2()
-- Replace older permissive policies to avoid accidental combination

-- PROFILES
DROP POLICY IF EXISTS profiles_admin ON public.profiles;
CREATE POLICY profiles_admin ON public.profiles
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- CLASSES
DROP POLICY IF EXISTS classes_admin ON public.classes;
CREATE POLICY classes_admin ON public.classes
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- STUDENTS
DROP POLICY IF EXISTS students_read ON public.students;
DROP POLICY IF EXISTS students_admin ON public.students;

CREATE POLICY students_read ON public.students
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin_aal2());

CREATE POLICY students_admin ON public.students
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- STUDENT_RESULTS
DROP POLICY IF EXISTS student_results_read ON public.student_results;
DROP POLICY IF EXISTS student_results_admin ON public.student_results;

CREATE POLICY student_results_read ON public.student_results
  FOR SELECT TO authenticated
  USING (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  );

CREATE POLICY student_results_admin ON public.student_results
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- ACTIVE_SESSIONS
DROP POLICY IF EXISTS active_sessions_read ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_write ON public.active_sessions;

CREATE POLICY active_sessions_read ON public.active_sessions
  FOR SELECT TO authenticated
  USING (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  );

CREATE POLICY active_sessions_write ON public.active_sessions
  FOR ALL TO authenticated
  USING (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  )
  WITH CHECK (
    student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid())
    OR public.is_admin_aal2()
  );

-- QUESTION_BANK
DROP POLICY IF EXISTS question_bank_read ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin ON public.question_bank;

CREATE POLICY question_bank_read ON public.question_bank
  FOR SELECT TO authenticated
  USING (public.is_admin_aal2());

CREATE POLICY question_bank_admin ON public.question_bank
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- CBT_EXAM_ANSWERS
DROP POLICY IF EXISTS cbt_exam_answers_admin_select ON public.cbt_exam_answers;
DROP POLICY IF EXISTS cbt_exam_answers_admin_only ON public.cbt_exam_answers;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT ON public.cbt_exam_answers TO authenticated;';
  END IF;
END;
$$;

CREATE POLICY cbt_exam_answers_admin_select ON public.cbt_exam_answers
  FOR SELECT TO authenticated
  USING (public.is_admin_aal2());

-- IMPORT_HISTORY
DROP POLICY IF EXISTS import_history_admin ON public.import_history;
CREATE POLICY import_history_admin ON public.import_history
  FOR ALL TO authenticated
  USING (public.is_admin_aal2())
  WITH CHECK (public.is_admin_aal2());

-- 4. Storage Policies on exam-assets (storage.objects)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
    DROP POLICY IF EXISTS exam_assets_read ON storage.objects;
    DROP POLICY IF EXISTS exam_assets_insert ON storage.objects;
    DROP POLICY IF EXISTS exam_assets_update ON storage.objects;
    DROP POLICY IF EXISTS exam_assets_delete ON storage.objects;

    CREATE POLICY exam_assets_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'exam-assets' AND (
          public.is_admin_aal2()
          OR EXISTS (
            SELECT 1
            FROM public.students stu
            JOIN public.cbt_exams_raw ex
              ON (ex.class = 'All' OR ex.class = stu.class)
             AND (ex.section IS NULL OR ex.section = stu.section)
            WHERE stu.id = auth.uid()
              AND ex.status = 'ACTIVE'
              AND (
                ex.questions_data::text LIKE '%' || name || '%'
                OR ex.questions_data::text LIKE '%' || split_part(name, '/', 2) || '%'
              )
          )
        )
      );

    CREATE POLICY exam_assets_insert ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'exam-assets' AND public.is_admin_aal2());

    CREATE POLICY exam_assets_update ON storage.objects
      FOR UPDATE TO authenticated
      USING (bucket_id = 'exam-assets' AND public.is_admin_aal2())
      WITH CHECK (bucket_id = 'exam-assets' AND public.is_admin_aal2());

    CREATE POLICY exam_assets_delete ON storage.objects
      FOR DELETE TO authenticated
      USING (bucket_id = 'exam-assets' AND public.is_admin_aal2());
  END IF;
END;
$$;
