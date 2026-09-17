-- Stage 21F: support the unfiltered active-roster ordering used by the
-- administrator pagination RPC without sorting archived rows.

CREATE INDEX students_active_roster_order_idx
  ON public.students (lower(student_id), id)
  WHERE archived_at IS NULL;
