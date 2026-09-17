-- Stage 21B, batch 3: close the search path on every remaining privileged
-- routine. Application relations/helper calls in these routines are already
-- schema-qualified; PostgreSQL's own built-ins remain implicitly resolvable
-- from pg_catalog when the path is empty.

BEGIN;

ALTER FUNCTION public.admin_clear_question_bank(text) SET search_path = '';
ALTER FUNCTION public.admin_deactivate_students(uuid[], text) SET search_path = '';
ALTER FUNCTION public.admin_delete_empty_class(uuid, text) SET search_path = '';
ALTER FUNCTION public.admin_delete_question(uuid) SET search_path = '';
ALTER FUNCTION public.admin_delete_unused_exam(uuid, text) SET search_path = '';
ALTER FUNCTION public.admin_finalize_expired_sessions(integer) SET search_path = '';
ALTER FUNCTION public.admin_import_questions(uuid, text, jsonb) SET search_path = '';
ALTER FUNCTION public.admin_operational_health() SET search_path = '';
ALTER FUNCTION public.admin_reactivate_students(uuid[]) SET search_path = '';
ALTER FUNCTION public.admin_update_student_assignment(uuid, text, text) SET search_path = '';
ALTER FUNCTION public.audit_class_admin_change() SET search_path = '';
ALTER FUNCTION public.audit_exam_admin_change() SET search_path = '';
ALTER FUNCTION public.audit_provisioned_student() SET search_path = '';
ALTER FUNCTION public.audit_question_admin_change() SET search_path = '';
ALTER FUNCTION public.block_direct_cbt_exams_raw_writes() SET search_path = '';
ALTER FUNCTION public.cleanup_unreferenced_exam_assets() SET search_path = '';
ALTER FUNCTION public.delete_students(uuid[]) SET search_path = '';
ALTER FUNCTION public.delete_user(uuid) SET search_path = '';
ALTER FUNCTION public.get_admin_exam_list_page(integer, integer, text, text) SET search_path = '';
ALTER FUNCTION public.get_admin_question_bank_page(integer, integer, text, text, text) SET search_path = '';
ALTER FUNCTION public.get_admin_questions_by_ids(uuid[]) SET search_path = '';
ALTER FUNCTION public.get_admin_student_roster_page(integer, integer, text, text, text) SET search_path = '';
ALTER FUNCTION public.get_unreferenced_exam_assets() SET search_path = '';
ALTER FUNCTION public.handle_cbt_exams_modification() SET search_path = '';
ALTER FUNCTION public.handle_new_user() SET search_path = '';
ALTER FUNCTION public.is_exam_asset_referenced(text) SET search_path = '';
ALTER FUNCTION public.preflight_validate_exam(uuid) SET search_path = '';
ALTER FUNCTION public.record_exam_asset_cleanup(text[]) SET search_path = '';
ALTER FUNCTION public.record_result_export(uuid, text, integer) SET search_path = '';
ALTER FUNCTION public.validate_cbt_exams_raw_record() SET search_path = '';
ALTER FUNCTION public.validate_full_exam_paper(text, jsonb) SET search_path = '';

COMMIT;
