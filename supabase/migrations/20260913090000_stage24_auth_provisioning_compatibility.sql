-- Stage 24: make trusted account provisioning compatible with GoTrue's
-- two-step Admin API write. Custom app_metadata is not guaranteed to be
-- visible to an AFTER INSERT trigger, so an unmarked Auth row must remain
-- powerless rather than aborting Auth itself. A service-role-only finalizer
-- creates the application profile/roster atomically after GoTrue completes.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  account_type text := COALESCE(NEW.raw_app_meta_data OPERATOR(pg_catalog.->>) 'account_type', '');
BEGIN
  IF COALESCE(NEW.raw_app_meta_data OPERATOR(pg_catalog.->>) 'provisioned_by', '')
       OPERATOR(pg_catalog.<>) 'admin' THEN
    -- Public sign-up is disabled, but fail closed if it is ever enabled by
    -- mistake: the Auth identity receives no profile, roster row, or access.
    RETURN NEW;
  END IF;

  IF account_type NOT IN ('student', 'admin') THEN
    RAISE EXCEPTION 'A valid server-owned account type is required';
  END IF;

  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name', pg_catalog.split_part(NEW.email, '@', 1)),
    account_type
  )
  ON CONFLICT (id) DO NOTHING;

  IF account_type OPERATOR(pg_catalog.=) 'student' THEN
    IF COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section', '') OPERATOR(pg_catalog.=) '' THEN
      RAISE EXCEPTION 'Student provisioning metadata is incomplete';
    END IF;

    INSERT INTO public.students (id, student_id, name, class, section)
    VALUES (
      NEW.id,
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id',
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name',
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class',
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section'
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_account_provisioning(account_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  account_row record;
  account_type text;
  account_name text;
  existing_role text;
BEGIN
  IF (SELECT auth.role()) OPERATOR(pg_catalog.<>) 'service_role' THEN
    RAISE EXCEPTION 'Service-role account provisioning is required';
  END IF;
  IF account_id_param IS NULL THEN
    RAISE EXCEPTION 'Account ID is required';
  END IF;

  SELECT id, email, raw_app_meta_data, raw_user_meta_data
  INTO account_row
  FROM auth.users
  WHERE id OPERATOR(pg_catalog.=) account_id_param
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth account not found'; END IF;

  IF COALESCE(account_row.raw_app_meta_data OPERATOR(pg_catalog.->>) 'provisioned_by', '')
       OPERATOR(pg_catalog.<>) 'admin' THEN
    RAISE EXCEPTION 'Auth account is missing its server-owned provisioning marker';
  END IF;
  account_type := COALESCE(account_row.raw_app_meta_data OPERATOR(pg_catalog.->>) 'account_type', '');
  IF account_type NOT IN ('student', 'admin') THEN
    RAISE EXCEPTION 'A valid server-owned account type is required';
  END IF;

  account_name := COALESCE(
    NULLIF(pg_catalog.btrim(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name'), ''),
    pg_catalog.split_part(account_row.email, '@', 1)
  );

  SELECT role INTO existing_role FROM public.profiles WHERE id OPERATOR(pg_catalog.=) account_id_param;
  IF FOUND AND existing_role OPERATOR(pg_catalog.<>) account_type THEN
    RAISE EXCEPTION 'Existing application profile has a conflicting account type';
  END IF;

  INSERT INTO public.profiles (id, email, name, role)
  VALUES (account_id_param, account_row.email, account_name, account_type)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name;

  IF account_type OPERATOR(pg_catalog.=) 'student' THEN
    IF COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section', '') OPERATOR(pg_catalog.=) '' THEN
      RAISE EXCEPTION 'Student provisioning metadata is incomplete';
    END IF;

    INSERT INTO public.students (id, student_id, name, class, section)
    VALUES (
      account_id_param,
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id',
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name',
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class',
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section'
    )
    ON CONFLICT (id) DO UPDATE SET
      student_id = EXCLUDED.student_id,
      name = EXCLUDED.name,
      class = EXCLUDED.class,
      section = EXCLUDED.section;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', account_id_param,
    'account_type', account_type,
    'provisioned', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_account_provisioning(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_account_provisioning(uuid) TO service_role;
