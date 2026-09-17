-- Stage 8: supporting indexes for the production dashboard and maintenance paths.
-- These are forward-only and use IF NOT EXISTS so rehearsals remain repeatable.

CREATE INDEX IF NOT EXISTS student_results_exam_student_idx
  ON public.student_results (exam_id, student_id);

CREATE INDEX IF NOT EXISTS active_sessions_deadline_idx
  ON public.active_sessions (deadline_at);

CREATE INDEX IF NOT EXISTS cbt_exams_created_id_idx
  ON public.cbt_exams_raw (created_at DESC, id);

CREATE INDEX IF NOT EXISTS cbt_exams_active_idx
  ON public.cbt_exams_raw (id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS question_bank_created_id_idx
  ON public.question_bank (created_at, id);

CREATE INDEX IF NOT EXISTS question_bank_missing_required_media_idx
  ON public.question_bank (id)
  WHERE has_image_or_diagram = true
    AND length(btrim(COALESCE(question_image_url, ''))) = 0;

CREATE INDEX IF NOT EXISTS students_archived_idx
  ON public.students (archived_at)
  WHERE archived_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_audit_events_occurred_idx
  ON public.admin_audit_events (occurred_at DESC, id DESC);
