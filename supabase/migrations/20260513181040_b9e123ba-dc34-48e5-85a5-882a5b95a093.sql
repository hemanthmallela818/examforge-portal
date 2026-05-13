
-- Fix search_path on set_updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Restrict SECURITY DEFINER functions to server-side only
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;
-- has_role is used inside RLS policies which run as the table owner, so revoking from authenticated still works

REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid) FROM PUBLIC, anon;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Need has_role to be callable inside policies. Policies run as definer of policy (table owner = postgres) so granting to authenticated is needed for direct calls from app:
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;

-- login_attempts: server-only, deny all client access explicitly
CREATE POLICY "Deny all client access to login_attempts" ON public.login_attempts
  FOR ALL TO authenticated, anon USING (false) WITH CHECK (false);
