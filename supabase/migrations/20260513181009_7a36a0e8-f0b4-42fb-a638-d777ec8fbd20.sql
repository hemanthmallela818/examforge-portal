
-- ============ ENUMS ============
CREATE TYPE public.app_role AS ENUM ('PRINCIPAL', 'STUDENT');
CREATE TYPE public.exam_status AS ENUM ('DRAFT', 'SCHEDULED', 'ONGOING', 'COMPLETED');
CREATE TYPE public.question_difficulty AS ENUM ('Easy', 'Medium', 'Hard');
CREATE TYPE public.option_letter AS ENUM ('A', 'B', 'C', 'D');
CREATE TYPE public.answer_letter AS ENUM ('A', 'B', 'C', 'D', 'NONE');
CREATE TYPE public.student_exam_status AS ENUM ('NOT_STARTED', 'ONGOING', 'SUBMITTED', 'TERMINATED');

-- ============ PROFILES ============
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ============ USER ROLES ============
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- ============ has_role function (security definer) ============
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE OR REPLACE FUNCTION public.get_user_role(_user_id UUID)
RETURNS public.app_role
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = _user_id LIMIT 1
$$;

-- ============ updated_at trigger helper ============
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SUBJECTS ============
CREATE TABLE public.subjects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.subjects ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_subjects_updated BEFORE UPDATE ON public.subjects
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ QUESTIONS ============
CREATE TABLE public.questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE RESTRICT,
  question_text TEXT NOT NULL,
  question_image TEXT,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  option_a_image TEXT,
  option_b_image TEXT,
  option_c_image TEXT,
  option_d_image TEXT,
  correct_option public.option_letter NOT NULL,
  difficulty public.question_difficulty NOT NULL DEFAULT 'Medium',
  topic_tag TEXT,
  marks INT NOT NULL DEFAULT 4,
  negative_marks NUMERIC NOT NULL DEFAULT 1,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_questions_subject ON public.questions(subject_id);
CREATE INDEX idx_questions_difficulty ON public.questions(difficulty);
CREATE TRIGGER trg_questions_updated BEFORE UPDATE ON public.questions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SOLUTIONS ============
CREATE TABLE public.solutions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL UNIQUE REFERENCES public.questions(id) ON DELETE CASCADE,
  solution_text TEXT NOT NULL,
  solution_image TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.solutions ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_solutions_updated BEFORE UPDATE ON public.solutions
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ EXAMS ============
CREATE TABLE public.exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  scheduled_date DATE,
  start_time TIME,
  duration_minutes INT NOT NULL DEFAULT 180,
  status public.exam_status NOT NULL DEFAULT 'DRAFT',
  marks_per_correct INT NOT NULL DEFAULT 4,
  negative_marking_ratio NUMERIC NOT NULL DEFAULT 1,
  randomize_questions BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER trg_exams_updated BEFORE UPDATE ON public.exams
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.exam_subjects (
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (exam_id, subject_id)
);
ALTER TABLE public.exam_subjects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.exam_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE RESTRICT,
  question_order INT NOT NULL,
  UNIQUE (exam_id, question_id)
);
ALTER TABLE public.exam_questions ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.exam_assignments (
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (exam_id, student_id)
);
ALTER TABLE public.exam_assignments ENABLE ROW LEVEL SECURITY;

-- ============ STUDENT EXAMS / ANSWERS / RESULTS ============
CREATE TABLE public.student_exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  status public.student_exam_status NOT NULL DEFAULT 'NOT_STARTED',
  total_score NUMERIC,
  termination_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, exam_id)
);
ALTER TABLE public.student_exams ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.student_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_exam_id UUID NOT NULL REFERENCES public.student_exams(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  selected_option public.answer_letter NOT NULL DEFAULT 'NONE',
  is_marked_for_review BOOLEAN NOT NULL DEFAULT false,
  time_spent_seconds INT NOT NULL DEFAULT 0,
  answered_at TIMESTAMPTZ,
  UNIQUE (student_exam_id, question_id)
);
ALTER TABLE public.student_answers ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.exam_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_exam_id UUID NOT NULL UNIQUE REFERENCES public.student_exams(id) ON DELETE CASCADE,
  subject_wise_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_correct INT NOT NULL DEFAULT 0,
  total_wrong INT NOT NULL DEFAULT 0,
  total_unattempted INT NOT NULL DEFAULT 0,
  percentile NUMERIC,
  rank INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.exam_results ENABLE ROW LEVEL SECURITY;

-- ============ AUDIT LOGS ============
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ============ LOGIN ATTEMPTS (lockout) ============
CREATE TABLE public.login_attempts (
  email TEXT PRIMARY KEY,
  failed_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- ============ NEW USER TRIGGER (creates profile) ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, created_by)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.email,
    NULLIF(NEW.raw_user_meta_data->>'created_by','')::uuid
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============ RLS POLICIES ============
-- profiles
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Principals can view all profiles" ON public.profiles
  FOR SELECT USING (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Principals can update all profiles" ON public.profiles
  FOR UPDATE USING (public.has_role(auth.uid(), 'PRINCIPAL'));

-- user_roles
CREATE POLICY "Users can view own role" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Principals can view all roles" ON public.user_roles
  FOR SELECT USING (public.has_role(auth.uid(), 'PRINCIPAL'));

-- subjects
CREATE POLICY "Authenticated can view subjects" ON public.subjects
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Principals manage subjects" ON public.subjects
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));

-- questions
CREATE POLICY "Principals manage questions" ON public.questions
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view questions in their exams" ON public.questions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.exam_questions eq
      JOIN public.exam_assignments ea ON ea.exam_id = eq.exam_id
      WHERE eq.question_id = questions.id AND ea.student_id = auth.uid()
    )
  );

-- solutions
CREATE POLICY "Principals manage solutions" ON public.solutions
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view solutions for completed exams" ON public.solutions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.student_exams se
      JOIN public.exam_questions eq ON eq.exam_id = se.exam_id
      WHERE eq.question_id = solutions.question_id
        AND se.student_id = auth.uid()
        AND se.status IN ('SUBMITTED','TERMINATED')
    )
  );

-- exams
CREATE POLICY "Principals manage exams" ON public.exams
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view assigned exams" ON public.exams
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.exam_assignments ea WHERE ea.exam_id = exams.id AND ea.student_id = auth.uid())
  );

-- exam_subjects
CREATE POLICY "Principals manage exam_subjects" ON public.exam_subjects
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view exam_subjects for assigned" ON public.exam_subjects
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.exam_assignments ea WHERE ea.exam_id = exam_subjects.exam_id AND ea.student_id = auth.uid())
  );

-- exam_questions
CREATE POLICY "Principals manage exam_questions" ON public.exam_questions
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view exam_questions assigned" ON public.exam_questions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.exam_assignments ea WHERE ea.exam_id = exam_questions.exam_id AND ea.student_id = auth.uid())
  );

-- exam_assignments
CREATE POLICY "Principals manage exam_assignments" ON public.exam_assignments
  FOR ALL USING (public.has_role(auth.uid(), 'PRINCIPAL'))
  WITH CHECK (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view own assignments" ON public.exam_assignments
  FOR SELECT USING (auth.uid() = student_id);

-- student_exams
CREATE POLICY "Principals view all student_exams" ON public.student_exams
  FOR SELECT USING (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Principals update student_exams" ON public.student_exams
  FOR UPDATE USING (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view own student_exams" ON public.student_exams
  FOR SELECT USING (auth.uid() = student_id);
CREATE POLICY "Students insert own student_exams" ON public.student_exams
  FOR INSERT WITH CHECK (auth.uid() = student_id);
CREATE POLICY "Students update own student_exams" ON public.student_exams
  FOR UPDATE USING (auth.uid() = student_id);

-- student_answers
CREATE POLICY "Principals view answers" ON public.student_answers
  FOR SELECT USING (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students manage own answers" ON public.student_answers
  FOR ALL USING (
    EXISTS (SELECT 1 FROM public.student_exams se WHERE se.id = student_answers.student_exam_id AND se.student_id = auth.uid())
  ) WITH CHECK (
    EXISTS (SELECT 1 FROM public.student_exams se WHERE se.id = student_answers.student_exam_id AND se.student_id = auth.uid())
  );

-- exam_results
CREATE POLICY "Principals view results" ON public.exam_results
  FOR SELECT USING (public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Students view own results" ON public.exam_results
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.student_exams se WHERE se.id = exam_results.student_exam_id AND se.student_id = auth.uid())
  );

-- audit_logs
CREATE POLICY "Principals view audit logs" ON public.audit_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'PRINCIPAL'));

-- login_attempts: server-only via service role; no client policies needed
