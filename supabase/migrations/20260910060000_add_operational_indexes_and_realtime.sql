-- Index the filters used by dashboards, cleanup operations, and session RPCs.
CREATE INDEX IF NOT EXISTS student_results_exam_id_idx ON public.student_results (exam_id);
CREATE INDEX IF NOT EXISTS student_results_student_id_idx ON public.student_results (student_id);
CREATE INDEX IF NOT EXISTS active_sessions_exam_id_idx ON public.active_sessions (exam_id);
CREATE INDEX IF NOT EXISTS active_sessions_student_id_idx ON public.active_sessions (student_id);
CREATE INDEX IF NOT EXISTS cbt_exams_assignment_idx ON public.cbt_exams_raw (class, section, created_at DESC);
CREATE INDEX IF NOT EXISTS question_bank_subject_created_idx ON public.question_bank (subject, created_at);

-- Realtime subscriptions are part of the product's synchronization behavior.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'cbt_exams_raw', 'student_results', 'students', 'question_bank', 'classes'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END LOOP;
END;
$$;
