-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL,
    name text,
    role text DEFAULT 'student',
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Classes table
CREATE TABLE IF NOT EXISTS public.classes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL UNIQUE,
    sections text[] DEFAULT '{}',
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now())
);

-- Students table
CREATE TABLE IF NOT EXISTS public.students (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    student_id text NOT NULL UNIQUE,
    name text NOT NULL,
    password text NOT NULL,
    session_token text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL,
    class text,
    section text
);

-- CBT Exams table
CREATE TABLE IF NOT EXISTS public.cbt_exams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    status text DEFAULT 'PENDING' NOT NULL,
    questions_data jsonb NOT NULL,
    class text,
    section text,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Active Sessions table
CREATE TABLE IF NOT EXISTS public.active_sessions (
    id text PRIMARY KEY,
    student_id text NOT NULL,
    exam_id text NOT NULL,
    user_responses jsonb,
    jumbled_exam_data jsonb,
    time_left integer,
    updated_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Student Results table
CREATE TABLE IF NOT EXISTS public.student_results (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id text NOT NULL,
    student_id text NOT NULL,
    student_name text,
    total_score numeric,
    max_score numeric,
    correct integer,
    incorrect integer,
    unattempted integer,
    subject_scores jsonb,
    submitted_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Question Bank table
CREATE TABLE IF NOT EXISTS public.question_bank (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category text DEFAULT 'Mains' NOT NULL,
    subject text NOT NULL,
    type text NOT NULL,
    question_text text NOT NULL,
    options jsonb NOT NULL DEFAULT '[]'::jsonb,
    correct_answer text NOT NULL,
    points integer DEFAULT 4 NOT NULL,
    neg_points integer DEFAULT -1 NOT NULL,
    explanation text,
    chapter text,
    difficulty text,
    question_image_url text,
    option_image_urls jsonb,
    has_image_or_diagram boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Import History table
CREATE TABLE IF NOT EXISTS public.import_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name text NOT NULL,
    total_questions integer NOT NULL,
    successful_imports integer NOT NULL,
    rejected_questions integer NOT NULL,
    status text NOT NULL,
    imported_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on all tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cbt_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_history ENABLE ROW LEVEL SECURITY;

-- Create get_my_role function
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text AS $$
DECLARE
  user_role text;
BEGIN
  SELECT role INTO user_role FROM public.profiles WHERE id = auth.uid();
  RETURN user_role;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create delete_user function
CREATE OR REPLACE FUNCTION public.delete_user(user_id uuid)
RETURNS void AS $$
BEGIN
  IF public.get_my_role() <> 'admin' AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Only admins can delete users';
  END IF;
  DELETE FROM auth.users WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS profiles_read ON public.profiles;
DROP POLICY IF EXISTS profiles_admin ON public.profiles;
DROP POLICY IF EXISTS classes_read ON public.classes;
DROP POLICY IF EXISTS classes_admin ON public.classes;
DROP POLICY IF EXISTS students_read ON public.students;
DROP POLICY IF EXISTS students_admin ON public.students;
DROP POLICY IF EXISTS cbt_exams_read ON public.cbt_exams;
DROP POLICY IF EXISTS cbt_exams_admin ON public.cbt_exams;
DROP POLICY IF EXISTS student_results_read ON public.student_results;
DROP POLICY IF EXISTS student_results_insert ON public.student_results;
DROP POLICY IF EXISTS student_results_admin ON public.student_results;
DROP POLICY IF EXISTS active_sessions_read ON public.active_sessions;
DROP POLICY IF EXISTS active_sessions_write ON public.active_sessions;
DROP POLICY IF EXISTS question_bank_read ON public.question_bank;
DROP POLICY IF EXISTS question_bank_admin ON public.question_bank;
DROP POLICY IF EXISTS import_history_admin ON public.import_history;

-- Profiles Policies
CREATE POLICY profiles_read ON public.profiles FOR SELECT USING (true);
CREATE POLICY profiles_admin ON public.profiles FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- Classes Policies
CREATE POLICY classes_read ON public.classes FOR SELECT USING (true);
CREATE POLICY classes_admin ON public.classes FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- Students Policies
CREATE POLICY students_read ON public.students FOR SELECT USING (public.get_my_role() = 'admin' OR auth.uid() = id);
CREATE POLICY students_admin ON public.students FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- CBT Exams Policies
CREATE POLICY cbt_exams_read ON public.cbt_exams FOR SELECT USING (true);
CREATE POLICY cbt_exams_admin ON public.cbt_exams FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- Student Results Policies
CREATE POLICY student_results_read ON public.student_results FOR SELECT USING (public.get_my_role() = 'admin' OR student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY student_results_insert ON public.student_results FOR INSERT WITH CHECK (true);
CREATE POLICY student_results_admin ON public.student_results FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- Active Sessions Policies
CREATE POLICY active_sessions_read ON public.active_sessions FOR SELECT USING (public.get_my_role() = 'admin' OR student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));
CREATE POLICY active_sessions_write ON public.active_sessions FOR ALL USING (public.get_my_role() = 'admin' OR student_id = (SELECT student_id FROM public.students WHERE id = auth.uid()));

-- Question Bank Policies
CREATE POLICY question_bank_read ON public.question_bank FOR SELECT USING (public.get_my_role() = 'admin');
CREATE POLICY question_bank_admin ON public.question_bank FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- Import History Policies
CREATE POLICY import_history_admin ON public.import_history FOR ALL TO authenticated USING (public.get_my_role() = 'admin');

-- Recreate trigger function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
    INSERT INTO public.profiles (id, email, name, role)
    VALUES (
        new.id,
        new.email,
        COALESCE(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
        CASE 
            WHEN new.email LIKE '%admin%' OR new.email = 'hemanthmallela818@gmail.com' THEN 'admin'
            ELSE 'student'
        END
    ) ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        role = EXCLUDED.role;
    
    IF NOT (new.email LIKE '%admin%' OR new.email = 'hemanthmallela818@gmail.com') THEN
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
    END IF;
    
    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Recreate trigger if not exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Keep answer keys in a separate, administrator-only table.  The application
-- continues to use public.cbt_exams for administrator CRUD, but students see
-- a security-invoker view that can never return correctAnswer values.
ALTER TABLE public.cbt_exams RENAME TO cbt_exams_raw;

CREATE TABLE public.cbt_exam_answers (
    exam_id uuid PRIMARY KEY REFERENCES public.cbt_exams_raw(id) ON DELETE CASCADE,
    answers jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.cbt_exam_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY cbt_exam_answers_admin_only ON public.cbt_exam_answers
  FOR ALL TO authenticated
  USING (public.get_my_role() = 'admin')
  WITH CHECK (public.get_my_role() = 'admin');

CREATE OR REPLACE FUNCTION public.reconstruct_exam_questions(qdata jsonb, ans jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  subject_name text;
  question_obj jsonb;
  reconstructed_subject_qs jsonb;
  reconstructed_questions jsonb;
  answer_info jsonb;
BEGIN
  IF qdata IS NULL OR NOT qdata ? 'questions' OR ans IS NULL THEN
    RETURN qdata;
  END IF;

  reconstructed_questions := '{}'::jsonb;
  FOR subject_name IN SELECT jsonb_object_keys(qdata->'questions') LOOP
    reconstructed_subject_qs := '[]'::jsonb;
    FOR question_obj IN SELECT jsonb_array_elements(qdata->'questions'->subject_name) LOOP
      answer_info := ans->(question_obj->>'id');
      IF answer_info IS NOT NULL THEN
        question_obj := jsonb_set(question_obj, '{correctAnswer}', answer_info->'correct_answer', true);
      END IF;
      reconstructed_subject_qs := reconstructed_subject_qs || question_obj;
    END LOOP;
    reconstructed_questions := jsonb_set(reconstructed_questions, ARRAY[subject_name], reconstructed_subject_qs, true);
  END LOOP;
  RETURN jsonb_set(qdata, '{questions}', reconstructed_questions, true);
END;
$$;

CREATE VIEW public.cbt_exams WITH (security_invoker = true) AS
SELECT r.id, r.title, r.status, r.class, r.section, r.created_at,
  CASE WHEN public.get_my_role() = 'admin'
    THEN public.reconstruct_exam_questions(r.questions_data, a.answers)
    ELSE r.questions_data
  END AS questions_data
FROM public.cbt_exams_raw r
LEFT JOIN public.cbt_exam_answers a ON r.id = a.exam_id;

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
BEGIN
  IF public.get_my_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only administrators can modify exams';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF NEW.questions_data IS NOT NULL AND NEW.questions_data ? 'questions' THEN
      FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
        clean_subject_questions := '[]'::jsonb;
        FOR question_obj IN SELECT jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
          answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object(
            'correct_answer', question_obj->'correctAnswer',
            'subject', subject_name,
            'type', question_obj->>'type'
          ), true);
          clean_subject_questions := clean_subject_questions || (question_obj - 'correctAnswer');
        END LOOP;
        clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
      END LOOP;
      clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);
    ELSE
      clean_qdata := NEW.questions_data;
    END IF;

    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, NEW.status, clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, now()));
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

CREATE TRIGGER cbt_exams_modification_trigger
  INSTEAD OF INSERT OR UPDATE OR DELETE ON public.cbt_exams
  FOR EACH ROW EXECUTE FUNCTION public.handle_cbt_exams_modification();
