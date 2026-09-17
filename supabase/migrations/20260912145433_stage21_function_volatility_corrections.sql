-- Stage 21E: align routine volatility with the expressions they execute so
-- PostgreSQL never caches or reorders them under an invalid planner promise.

BEGIN;

ALTER FUNCTION public.sanitize_exam_responses(jsonb, jsonb) STABLE;
ALTER FUNCTION public.exam_progress_to_submission(jsonb, jsonb) STABLE;
ALTER FUNCTION public.normalize_submission_response_map(jsonb, jsonb) STABLE;
ALTER FUNCTION public.admin_operational_health() VOLATILE;

COMMIT;
