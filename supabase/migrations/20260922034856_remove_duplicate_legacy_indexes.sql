-- Older hosted schemas carried duplicate uniqueness enforcement. Retain the
-- canonical constraints and remove only the redundant legacy definitions.
ALTER TABLE public.student_results
  DROP CONSTRAINT IF EXISTS unique_student_exam_result;
DROP INDEX IF EXISTS public.idx_students_student_id;
