-- Stage 20 forward-only correction: harden the privileged question manifest
-- and make the protected exam view's Data API grants explicit. The preceding
-- migration remains immutable.

BEGIN;

-- Both functions run as their owner. An empty search_path prevents attacker-
-- controlled objects in exposed schemas from participating in name resolution.
-- All relations and application functions used by the manifest are already
-- schema-qualified; pg_catalog remains implicitly available for built-ins.
ALTER FUNCTION public.exam_questions_for_viewer(uuid)
  SET search_path = '';

ALTER FUNCTION public.reconstruct_exam_questions(jsonb, jsonb)
  SET search_path = '';

-- Existing Supabase projects may have direct role grants in addition to the
-- default PUBLIC grant. Remove both. Authenticated callers require the manifest
-- privilege because the security-invoker cbt_exams view calls it; the lower-
-- level reconstruction helper is internal only.
REVOKE ALL ON FUNCTION public.exam_questions_for_viewer(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.exam_questions_for_viewer(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.reconstruct_exam_questions(jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;

-- CREATE OR REPLACE VIEW preserves old ACLs. Replace inherited/default ACLs
-- with the exact browser API surface: no anonymous access, authenticated reads
-- plus the existing trigger-guarded administrator mutation path.
REVOKE ALL ON TABLE public.cbt_exams FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.cbt_exams FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cbt_exams
  TO authenticated;

COMMIT;
