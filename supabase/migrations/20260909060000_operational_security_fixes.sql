-- Close production gaps found during the operational security review.

-- Database-size information is an administrative diagnostic, not a public RPC.
CREATE OR REPLACE FUNCTION public.get_db_size()
RETURNS TABLE(table_name text, size_bytes bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF public.get_my_role() <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access is required';
  END IF;

  RETURN QUERY
  SELECT c.relname::text, pg_total_relation_size(c.oid)::bigint
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY c.relname;
END;
$$;
REVOKE ALL ON FUNCTION public.get_db_size() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_db_size() TO authenticated;

-- "All" is a valid target for common mock tests. Keep the RLS rule and client
-- filter consistent, including null legacy values as unrestricted targets.
DROP POLICY IF EXISTS cbt_exams_read_assigned ON public.cbt_exams_raw;
CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw FOR SELECT TO authenticated
  USING (
    public.get_my_role() = 'admin'
    OR EXISTS (
      SELECT 1
      FROM public.students s
      WHERE s.id = auth.uid()
        AND (cbt_exams_raw.class IS NULL OR cbt_exams_raw.class = 'All' OR s.class = cbt_exams_raw.class)
        AND (cbt_exams_raw.section IS NULL OR cbt_exams_raw.section = 'All' OR s.section = cbt_exams_raw.section)
    )
  );

-- One server request for roster cleanup avoids N separate browser-to-database
-- round trips. delete_user remains the single authority for Auth cleanup.
CREATE OR REPLACE FUNCTION public.delete_students(user_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_id uuid;
BEGIN
  IF public.get_my_role() <> 'admin' THEN
    RAISE EXCEPTION 'Administrator access is required';
  END IF;

  FOREACH user_id IN ARRAY COALESCE(user_ids, ARRAY[]::uuid[]) LOOP
    PERFORM public.delete_user(user_id);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.delete_students(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_students(uuid[]) TO authenticated;

-- The bucket is private. Anonymous callers must not be able to query or obtain
-- a signed URL for a diagram. A student may read only a file referenced by an
-- exam assigned to that student's class and section; administrators retain full access.
DROP POLICY IF EXISTS exam_assets_read ON storage.objects;
CREATE POLICY exam_assets_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'exam-assets'
    AND (
      public.get_my_role() = 'admin'
      OR EXISTS (
        SELECT 1
        FROM public.cbt_exams_raw e
        JOIN public.students s ON s.id = auth.uid()
        WHERE (e.class IS NULL OR e.class = 'All' OR e.class = s.class)
          AND (e.section IS NULL OR e.section = 'All' OR e.section = s.section)
          AND e.questions_data::text LIKE '%' || storage.objects.name || '%'
      )
    )
  );
