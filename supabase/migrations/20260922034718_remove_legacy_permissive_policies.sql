-- Remove permissive policies found only on older hosted projects. These names
-- are safe to drop conditionally and the hardened replacement policies already
-- exist in the forward migration history.
DROP POLICY IF EXISTS classes_all_admin ON public.classes;
DROP POLICY IF EXISTS classes_select ON public.classes;
DROP POLICY IF EXISTS "Admins have full access to import history" ON public.import_history;
DROP POLICY IF EXISTS "Admins have full access to question bank" ON public.question_bank;

CREATE INDEX IF NOT EXISTS managed_administrators_created_by_idx
  ON public.managed_administrators(created_by);
