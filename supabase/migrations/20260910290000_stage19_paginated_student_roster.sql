-- Stage 19A: bounded, server-filtered administrator student roster.

CREATE INDEX IF NOT EXISTS students_roster_filter_order_idx
  ON public.students (class, section, lower(student_id), id);

CREATE OR REPLACE FUNCTION public.get_admin_student_roster_page(
  page_number_param integer,
  page_size_param integer,
  search_param text DEFAULT NULL,
  class_param text DEFAULT NULL,
  section_param text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  normalized_class text := NULLIF(btrim(COALESCE(class_param, '')), '');
  normalized_section text := NULLIF(btrim(COALESCE(section_param, '')), '');
  total_count integer;
  page_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 200';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Roster search must not exceed 100 characters';
  END IF;
  IF normalized_class IS NOT NULL AND length(normalized_class) > 100 THEN
    RAISE EXCEPTION 'Class filter must not exceed 100 characters';
  END IF;
  IF normalized_section IS NOT NULL AND length(normalized_section) > 100 THEN
    RAISE EXCEPTION 'Section filter must not exceed 100 characters';
  END IF;

  SELECT count(*)::integer INTO total_count
  FROM public.students student
  WHERE (normalized_class IS NULL OR student.class = normalized_class)
    AND (normalized_section IS NULL OR student.section = normalized_section)
    AND (
      normalized_search IS NULL
      OR position(lower(normalized_search) in lower(student.student_id)) > 0
      OR position(lower(normalized_search) in lower(student.name)) > 0
    );

  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.sort_id, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT
      lower(student.student_id) AS sort_id,
      student.id,
      jsonb_build_object(
        'id', student.id,
        'student_id', student.student_id,
        'name', student.name,
        'class', student.class,
        'section', student.section,
        'archived_at', student.archived_at,
        'archive_reason', student.archive_reason,
        'created_at', student.created_at
      ) AS payload
    FROM public.students student
    WHERE (normalized_class IS NULL OR student.class = normalized_class)
      AND (normalized_section IS NULL OR student.section = normalized_section)
      AND (
        normalized_search IS NULL
        OR position(lower(normalized_search) in lower(student.student_id)) > 0
        OR position(lower(normalized_search) in lower(student.name)) > 0
      )
    ORDER BY lower(student.student_id), student.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object(
    'page', page_number_param,
    'page_size', page_size_param,
    'total', total_count,
    'rows', page_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_student_roster_page(integer, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_student_roster_page(integer, integer, text, text, text) TO authenticated;
