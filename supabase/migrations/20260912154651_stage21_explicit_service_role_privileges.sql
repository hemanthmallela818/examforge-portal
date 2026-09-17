-- Stage 21H: auto exposure is disabled, so the trusted service role also needs
-- an explicit current-object allowlist. These grants do not change future
-- defaults; every later migration must grant service access intentionally.

BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

COMMIT;
