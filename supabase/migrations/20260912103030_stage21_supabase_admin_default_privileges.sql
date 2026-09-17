-- Stage 21A compatibility guard for platform-owned defaults.
--
-- Supabase intentionally does not make the application migration role a
-- member of supabase_admin. Local and hosted platform-owned object exposure is
-- therefore controlled by api.auto_expose_new_tables. If a self-hosted runner
-- explicitly grants that membership, also harden its defaults here.

BEGIN;

DO $stage21$
BEGIN
  IF pg_catalog.pg_has_role(current_user, 'supabase_admin', 'MEMBER') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public '
      || 'REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public '
      || 'REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public '
      || 'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated';
  END IF;
END
$stage21$;

COMMIT;
