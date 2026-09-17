-- Only accounts created by a trusted server process may enter the roster.
-- Disable public email sign-ups in Supabase Auth as an additional control.

BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  account_type text := COALESCE(new.raw_app_meta_data->>'account_type', '');
BEGIN
  IF COALESCE(new.raw_app_meta_data->>'provisioned_by', '') <> 'admin' THEN
    RAISE EXCEPTION 'Accounts must be provisioned by an administrator';
  END IF;

  IF account_type NOT IN ('student', 'admin') THEN
    RAISE EXCEPTION 'A valid server-owned account type is required';
  END IF;

  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    account_type
  ) ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name;

  IF account_type = 'student' THEN
    IF COALESCE(new.raw_user_meta_data->>'student_id', '') = ''
       OR COALESCE(new.raw_user_meta_data->>'name', '') = ''
       OR COALESCE(new.raw_user_meta_data->>'class', '') = ''
       OR COALESCE(new.raw_user_meta_data->>'section', '') = '' THEN
      RAISE EXCEPTION 'Student provisioning metadata is incomplete';
    END IF;

    INSERT INTO public.students (id, student_id, name, class, section)
    VALUES (
      new.id,
      new.raw_user_meta_data->>'student_id',
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'class',
      new.raw_user_meta_data->>'section'
    ) ON CONFLICT (id) DO UPDATE SET
      student_id = EXCLUDED.student_id,
      name = EXCLUDED.name,
      class = EXCLUDED.class,
      section = EXCLUDED.section;
  END IF;

  RETURN new;
END;
$$;

-- Authentication passwords belong only in Supabase Auth. This removes legacy
-- plaintext or placeholder values from the application schema.
ALTER TABLE public.students DROP COLUMN IF EXISTS password;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_valid;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_valid CHECK (role IN ('student', 'admin')) NOT VALID;

ALTER TABLE public.cbt_exams_raw
  DROP CONSTRAINT IF EXISTS cbt_exams_status_valid;
ALTER TABLE public.cbt_exams_raw
  ADD CONSTRAINT cbt_exams_status_valid CHECK (status IN ('PENDING', 'ACTIVE', 'ENDED')) NOT VALID;

COMMIT;
