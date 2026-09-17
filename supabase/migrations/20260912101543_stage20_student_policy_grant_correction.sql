-- Stage 20 forward-only correction: make the student lookup privileges used
-- by RLS policies explicit without exposing lifecycle audit fields or any
-- future roster columns by default.

BEGIN;

-- Grants and RLS are independent. The assignment policies on exams, results,
-- sessions, classes, and exam assets query these columns before their row
-- predicates can be evaluated. Remove legacy/default blanket reads first so
-- the column allowlist below is authoritative on old and new projects.
REVOKE SELECT ON TABLE public.students FROM PUBLIC, anon, authenticated;

GRANT SELECT (
  id,
  student_id,
  name,
  class,
  section,
  created_at,
  active_auth_session_id,
  archived_at
) ON TABLE public.students TO authenticated;

COMMIT;
