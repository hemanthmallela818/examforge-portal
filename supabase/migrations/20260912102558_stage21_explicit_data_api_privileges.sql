-- Stage 21A: explicit, deny-by-default Data API privileges.
-- RLS remains the row-level authority; these grants define which objects and
-- columns are reachable through PostgREST/GraphQL/Realtime in the first place.

BEGIN;

REVOKE CREATE ON SCHEMA public FROM PUBLIC, anon, authenticated;

-- Prevent future migrations owned by postgres from silently publishing new
-- objects to browser roles. service_role keeps its platform-managed defaults.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- Start from no browser table access. Anonymous users do not need any public
-- database object for login; GoTrue handles authentication separately.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Authenticated read surfaces. Every base table below has RLS enabled.
GRANT SELECT ON TABLE
  public.profiles,
  public.active_sessions,
  public.student_results,
  public.admin_audit_events,
  public.import_history,
  public.question_import_batches
TO authenticated;

-- AAL2 RLS policies and the answer-safe view/trigger own these admin writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.classes,
  public.question_bank,
  public.cbt_exams
TO authenticated;

-- Candidates need exam metadata for assignment/status/Realtime, never the raw
-- paper. Administrators receive the full paper only through public.cbt_exams.
GRANT SELECT (id, title, status, class, section, created_at)
  ON TABLE public.cbt_exams_raw TO authenticated;

-- RLS policy lookups, duplicate checks, and takeover Realtime use only these
-- roster fields. Lifecycle audit fields remain RPC-only for AAL2 admins.
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

-- Answer keys are consumed only by owner-executed grading/manifest functions.
REVOKE ALL PRIVILEGES ON TABLE public.cbt_exam_answers FROM anon, authenticated;

-- Default Supabase ACLs granted every new public function to browser roles.
-- Remove that inherited API, then publish only reviewed entry points.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.is_admin_aal2() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_auth_session_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_student_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_student_session() TO authenticated;
GRANT EXECUTE ON FUNCTION public.start_exam_session(uuid, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_active_session_progress(uuid, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_exam(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_student_exam_result(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.exam_questions_for_viewer(uuid) TO authenticated;

-- Functions referenced directly by RLS policies must remain executable by the
-- evaluated role even though they are not user-facing UI actions.
GRANT EXECUTE ON FUNCTION public.is_exam_asset_referenced(text) TO authenticated;

-- Administrator RPC surface; every function enforces AAL2 internally.
GRANT EXECUTE ON FUNCTION public.get_db_size() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_operational_health() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unreferenced_exam_assets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_exam_asset_cleanup(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preflight_validate_exam(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finalize_expired_sessions(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_question(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_question_bank(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_unused_exam(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_deactivate_students(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_students(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_empty_class(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_student_assignment(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_import_questions(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_result_export(uuid, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_student_roster_page(integer, integer, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_question_bank_page(integer, integer, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_questions_by_ids(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_exam_list_page(integer, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_exam_results_page(uuid, integer, integer, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_exam_results_export_page(uuid, text, integer, integer) TO authenticated;

COMMIT;
