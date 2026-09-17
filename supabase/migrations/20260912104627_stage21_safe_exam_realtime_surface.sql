-- Stage 21C: metadata-only exam Realtime surface. Raw exam papers and answer
-- material never enter the browser-visible logical replication stream.

BEGIN;

CREATE TABLE public.exam_status_events (
  exam_id pg_catalog.uuid PRIMARY KEY,
  title pg_catalog.text NOT NULL,
  status pg_catalog.text NOT NULL
    CHECK (status IN ('PENDING', 'ACTIVE', 'ENDED', 'DELETED')),
  class pg_catalog.text,
  section pg_catalog.text,
  changed_at pg_catalog.timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.exam_status_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.exam_status_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.exam_status_events TO authenticated;

CREATE POLICY exam_status_events_read_assigned
ON public.exam_status_events
FOR SELECT
TO authenticated
USING (
  public.is_admin_aal2()
  OR EXISTS (
    SELECT 1
    FROM public.students AS s
    WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
      AND s.archived_at IS NULL
      AND (
        exam_status_events.class IS NULL
        OR exam_status_events.class OPERATOR(pg_catalog.=) 'All'
        OR exam_status_events.class OPERATOR(pg_catalog.=) s.class
      )
      AND (
        exam_status_events.section IS NULL
        OR exam_status_events.section OPERATOR(pg_catalog.=) 'All'
        OR exam_status_events.section OPERATOR(pg_catalog.=) s.section
      )
  )
);

CREATE OR REPLACE FUNCTION public.sync_exam_status_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF TG_OP OPERATOR(pg_catalog.=) 'DELETE' THEN
    INSERT INTO public.exam_status_events (
      exam_id,
      title,
      status,
      class,
      section,
      changed_at
    ) VALUES (
      OLD.id,
      OLD.title,
      'DELETED',
      OLD.class,
      OLD.section,
      pg_catalog.clock_timestamp()
    )
    ON CONFLICT (exam_id) DO UPDATE
    SET title = EXCLUDED.title,
        status = EXCLUDED.status,
        class = EXCLUDED.class,
        section = EXCLUDED.section,
        changed_at = EXCLUDED.changed_at;
    RETURN OLD;
  END IF;

  INSERT INTO public.exam_status_events (
    exam_id,
    title,
    status,
    class,
    section,
    changed_at
  ) VALUES (
    NEW.id,
    NEW.title,
    NEW.status,
    NEW.class,
    NEW.section,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (exam_id) DO UPDATE
  SET title = EXCLUDED.title,
      status = EXCLUDED.status,
      class = EXCLUDED.class,
      section = EXCLUDED.section,
      changed_at = EXCLUDED.changed_at;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_exam_status_event()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_exam_status_event_trigger ON public.cbt_exams_raw;
CREATE TRIGGER sync_exam_status_event_trigger
AFTER INSERT OR UPDATE OR DELETE ON public.cbt_exams_raw
FOR EACH ROW EXECUTE FUNCTION public.sync_exam_status_event();

INSERT INTO public.exam_status_events (
  exam_id,
  title,
  status,
  class,
  section,
  changed_at
)
SELECT e.id, e.title, e.status, e.class, e.section, e.created_at
FROM public.cbt_exams_raw AS e
ON CONFLICT (exam_id) DO UPDATE
SET title = EXCLUDED.title,
    status = EXCLUDED.status,
    class = EXCLUDED.class,
    section = EXCLUDED.section,
    changed_at = EXCLUDED.changed_at;

DO $publication$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_publication_tables AS p
    WHERE p.pubname OPERATOR(pg_catalog.=) 'supabase_realtime'
      AND p.schemaname OPERATOR(pg_catalog.=) 'public'
      AND p.tablename OPERATOR(pg_catalog.=) 'cbt_exams_raw'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.cbt_exams_raw;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_publication_tables AS p
    WHERE p.pubname OPERATOR(pg_catalog.=) 'supabase_realtime'
      AND p.schemaname OPERATOR(pg_catalog.=) 'public'
      AND p.tablename OPERATOR(pg_catalog.=) 'exam_status_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.exam_status_events;
  END IF;
END
$publication$;

CREATE INDEX exam_status_events_assignment_idx
  ON public.exam_status_events (status, class, section, changed_at DESC);

COMMIT;
