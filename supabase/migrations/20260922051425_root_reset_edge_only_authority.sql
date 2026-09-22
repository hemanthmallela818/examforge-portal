-- Keep destructive reset routines off the authenticated Data API surface.
-- Only the server-side Edge Function may call these actor-bound wrappers.

REVOKE ALL ON FUNCTION public.root_application_reset_preview() FROM authenticated;
REVOKE ALL ON FUNCTION public.root_reset_application_data(text) FROM authenticated;

CREATE OR REPLACE FUNCTION public.root_application_reset_preview_for_actor(actor_id_param uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner
    WHERE owner.user_id = actor_id_param
  ) THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  RETURN public.root_application_reset_preview();
END;
$function$;

CREATE OR REPLACE FUNCTION public.root_reset_application_data_for_actor(
  actor_id_param uuid,
  confirmation_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner
    WHERE owner.user_id = actor_id_param
  ) THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  RETURN public.root_reset_application_data(confirmation_param);
END;
$function$;

REVOKE ALL ON FUNCTION public.root_application_reset_preview_for_actor(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.root_reset_application_data_for_actor(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.root_application_reset_preview_for_actor(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.root_reset_application_data_for_actor(uuid, text) TO service_role;
