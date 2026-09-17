-- Question and option images belong in Storage, not JSON/base64 database rows.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('exam-assets', 'exam-assets', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS exam_assets_read ON storage.objects;
DROP POLICY IF EXISTS exam_assets_admin_insert ON storage.objects;
DROP POLICY IF EXISTS exam_assets_admin_update ON storage.objects;
DROP POLICY IF EXISTS exam_assets_admin_delete ON storage.objects;

CREATE POLICY exam_assets_read ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'exam-assets');

CREATE POLICY exam_assets_admin_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin');

CREATE POLICY exam_assets_admin_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin')
  WITH CHECK (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin');

CREATE POLICY exam_assets_admin_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin');
