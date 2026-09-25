-- U3: institution branding (name, primary colour, logo).
--
-- The branding is shown on the login page, so it must be readable before
-- sign-in. It is kept in a singleton table with no direct grants; the public
-- surface is get_public_branding(), which exposes only the institution name,
-- primary colour and logo location (callable by anon and authenticated).
-- Only the root developer can change it, through root_update_branding(), and
-- every change is recorded in admin_audit_events.
--
-- Logo storage: a dedicated PUBLIC `branding` bucket, not the private
-- `exam-assets` bucket. The anonymous login page must be able to load the
-- logo without a signed URL, and exam-assets objects are subject to the
-- unreferenced-asset cleanup (get_unreferenced_exam_assets). Public buckets
-- serve objects by exact URL only; there is no anon SELECT policy, so the
-- bucket cannot be listed. Uploads are limited to 1 MB PNG/WebP files (the
-- client re-encodes every logo; SVG is never accepted) named
-- logo-<uuid>.png|webp, and only the root developer may insert or delete.

BEGIN;

CREATE TABLE public.institution_branding (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  institution_name text CHECK (
    institution_name IS NULL OR (
      char_length(institution_name) BETWEEN 1 AND 80
      AND institution_name = btrim(institution_name)
      AND institution_name !~ '[[:cntrl:]]'
    )
  ),
  primary_color text CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9a-f]{6}$'),
  logo_path text CHECK (
    logo_path IS NULL
    OR logo_path ~ '^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$'
  ),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid
);

COMMENT ON TABLE public.institution_branding IS
  'Singleton institution branding (NULL values mean the ExamForge defaults). Read through get_public_branding(); written only by root_update_branding().';

INSERT INTO public.institution_branding (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.institution_branding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.institution_branding FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.institution_branding TO service_role;

-- Public logo bucket.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('branding', 'branding', true, 1048576, ARRAY['image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS branding_root_select ON storage.objects;
DROP POLICY IF EXISTS branding_root_insert ON storage.objects;
DROP POLICY IF EXISTS branding_root_delete ON storage.objects;

-- Root may list/delete logos (the Storage API needs SELECT to delete).
CREATE POLICY branding_root_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'branding' AND (SELECT public.is_root_developer()));

CREATE POLICY branding_root_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'branding'
    AND (SELECT public.is_root_developer())
    AND name ~ '^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$'
  );

CREATE POLICY branding_root_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'branding' AND (SELECT public.is_root_developer()));

CREATE OR REPLACE FUNCTION public.get_public_branding()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'institution_name', b.institution_name,
    'primary_color', b.primary_color,
    'logo_path', b.logo_path,
    -- Relative to the Supabase project URL (public bucket object).
    'logo_url', CASE WHEN b.logo_path IS NULL THEN NULL
                     ELSE '/storage/v1/object/public/branding/' || b.logo_path END,
    'updated_at', b.updated_at
  )
  FROM public.institution_branding AS b
  WHERE b.id;
$function$;
REVOKE ALL ON FUNCTION public.get_public_branding() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_branding() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.root_update_branding(
  institution_name_param text,
  primary_color_param text,
  logo_path_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  next_name text;
  next_color text;
  next_logo text;
  previous public.institution_branding%ROWTYPE;
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required' USING ERRCODE = '42501';
  END IF;

  next_name := NULLIF(btrim(pg_catalog.regexp_replace(COALESCE(institution_name_param, ''), '\s+', ' ', 'g')), '');
  IF next_name IS NOT NULL AND (char_length(next_name) > 80 OR next_name ~ '[[:cntrl:]]') THEN
    RAISE EXCEPTION 'Institution name must be 1 to 80 printable characters' USING ERRCODE = '22023';
  END IF;

  next_color := NULLIF(lower(btrim(COALESCE(primary_color_param, ''))), '');
  IF next_color IS NOT NULL AND next_color !~ '^#[0-9a-f]{6}$' THEN
    RAISE EXCEPTION 'Primary colour must be a #RRGGBB hex colour' USING ERRCODE = '22023';
  END IF;

  next_logo := NULLIF(btrim(COALESCE(logo_path_param, '')), '');
  IF next_logo IS NOT NULL THEN
    IF next_logo !~ '^logo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|webp)$' THEN
      RAISE EXCEPTION 'Logo path is not a branding logo' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects AS o WHERE o.bucket_id = 'branding' AND o.name = next_logo) THEN
      RAISE EXCEPTION 'Logo file was not found in the branding bucket' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT * INTO previous FROM public.institution_branding WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.institution_branding (id) VALUES (true) RETURNING * INTO previous;
  END IF;

  UPDATE public.institution_branding
  SET institution_name = next_name,
      primary_color = next_color,
      logo_path = next_logo,
      updated_at = pg_catalog.clock_timestamp(),
      updated_by = auth.uid()
  WHERE id;

  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(), 'UPDATE_BRANDING', 'institution_branding', NULL,
    pg_catalog.jsonb_build_object(
      'institution_name', next_name,
      'primary_color', next_color,
      'logo_changed', previous.logo_path IS DISTINCT FROM next_logo,
      'previous_logo_path', previous.logo_path,
      'reset_to_defaults', next_name IS NULL AND next_color IS NULL AND next_logo IS NULL
    )
  );

  RETURN public.get_public_branding();
END;
$function$;
REVOKE ALL ON FUNCTION public.root_update_branding(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.root_update_branding(text, text, text) TO authenticated;

COMMIT;
