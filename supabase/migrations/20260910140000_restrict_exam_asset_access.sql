-- Restore assignment- and reference-scoped reads for private exam assets.
-- Migration 20260910130000 accidentally allowed every rostered student to read
-- every object in the bucket.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    DROP POLICY IF EXISTS exam_assets_read ON storage.objects;

    CREATE POLICY exam_assets_read ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'exam-assets'
        AND (
          public.is_admin_aal2()
          OR EXISTS (
            SELECT 1
            FROM public.students AS student
            JOIN public.cbt_exams_raw AS exam
              ON (exam.class IS NULL OR exam.class = 'All' OR exam.class = student.class)
             AND (exam.section IS NULL OR exam.section = 'All' OR exam.section = student.section)
            WHERE student.id = auth.uid()
              AND exam.status = 'ACTIVE'
              -- Asset paths are stored as complete JSON string values. A JSONPath
              -- equality check avoids substring and SQL wildcard matches.
              AND jsonb_path_exists(
                exam.questions_data,
                '$.** ? (@ == $asset)',
                jsonb_build_object('asset', storage.objects.name)
              )
          )
        )
      );
  END IF;
END;
$$;
