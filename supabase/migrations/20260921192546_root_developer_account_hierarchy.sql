-- Password-only administration with one service-bootstrapped owner.
CREATE TABLE public.application_owner (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT
);
CREATE TABLE public.managed_administrators (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.application_owner(user_id),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.application_owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.managed_administrators ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.application_owner, public.managed_administrators FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.application_owner, public.managed_administrators TO service_role;

CREATE FUNCTION public.is_root_developer() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.application_owner o
    JOIN public.profiles p ON p.id = o.user_id
    WHERE o.user_id = auth.uid() AND p.role = 'admin');
$$;
REVOKE ALL ON FUNCTION public.is_root_developer() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_root_developer() TO authenticated, service_role;

-- Keep the historical helper name for existing RLS/RPC callers. MFA is no
-- longer required; profile role alone cannot mint administrative authority.
CREATE OR REPLACE FUNCTION public.is_admin_aal2() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT auth.role()) = 'service_role' THEN RETURN true; END IF;
  IF (SELECT auth.role()) IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RETURN false; END IF;
  RETURN public.is_root_developer() OR EXISTS (
    SELECT 1 FROM public.managed_administrators a
    JOIN public.profiles p ON p.id = a.user_id
    WHERE a.user_id = auth.uid() AND a.enabled AND p.role = 'admin'
  );
END;
$$;
REVOKE ALL ON FUNCTION public.is_admin_aal2() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin_aal2() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN p.role = 'admin' THEN
    CASE WHEN public.is_admin_aal2() THEN 'admin' ELSE NULL END
    ELSE p.role END FROM public.profiles p WHERE p.id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.get_my_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticated, service_role;
-- Account identity and privilege writes belong to the trusted provisioning API.
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;

GRANT SELECT ON public.managed_administrators TO authenticated;
CREATE POLICY owner_reads_administrators ON public.managed_administrators
FOR SELECT TO authenticated USING ((SELECT public.is_root_developer()));

CREATE FUNCTION public.register_managed_administrator(account_id_param uuid, creator_id_param uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Trusted provisioning required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.application_owner WHERE user_id = creator_id_param)
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = account_id_param AND role = 'admin')
    OR account_id_param = creator_id_param THEN
    RAISE EXCEPTION 'Invalid administrator creator or account';
  END IF;
  INSERT INTO public.managed_administrators(user_id, created_by) VALUES (account_id_param, creator_id_param);
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (creator_id_param, 'CREATE_ADMINISTRATOR', 'profile', account_id_param::text, '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.register_managed_administrator(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_managed_administrator(uuid, uuid) TO service_role;

CREATE FUNCTION public.set_managed_administrator_enabled(account_id_param uuid, enabled_param boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access required'; END IF;
  IF enabled_param IS NULL THEN RAISE EXCEPTION 'Enabled state is required'; END IF;
  UPDATE public.managed_administrators SET enabled = enabled_param WHERE user_id = account_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Managed administrator not found'; END IF;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'SET_ADMINISTRATOR_ACCESS', 'profile', account_id_param::text,
      pg_catalog.jsonb_build_object('enabled', enabled_param));
END;
$$;
REVOKE ALL ON FUNCTION public.set_managed_administrator_enabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_managed_administrator_enabled(uuid, boolean) TO authenticated;
