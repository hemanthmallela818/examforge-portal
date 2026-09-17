-- ============================================================================
-- Migration 20260910100000: Safe Referential Integrity & Archival Protections
-- Prevents cascading deletion of student attempts, scorecards, and class records.
-- Guarantees that active sessions and completed results reference valid exams.
-- ============================================================================

-- 1. Prevent deletion of exams that have student results or active sessions
CREATE OR REPLACE FUNCTION public.protect_exam_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.student_results
    WHERE exam_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'Cannot delete exam "%" (%) because student submission results exist. Historical examination records must be retained. Set status to ENDED instead.',
      OLD.title, OLD.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.active_sessions
    WHERE exam_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'Cannot delete exam "%" (%) because students currently have active examination sessions.',
      OLD.title, OLD.id;
  END IF;

  -- Clean up private answer key if the exam had no attempts and was safely deleted
  DELETE FROM public.cbt_exam_answers WHERE exam_id = OLD.id;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS protect_exam_deletion_trigger ON public.cbt_exams_raw;
CREATE TRIGGER protect_exam_deletion_trigger
  BEFORE DELETE ON public.cbt_exams_raw
  FOR EACH ROW EXECUTE FUNCTION public.protect_exam_deletion();

-- 2. Prevent deletion of classes that have assigned students or exams
CREATE OR REPLACE FUNCTION public.protect_class_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.students
    WHERE class = OLD.name
  ) THEN
    RAISE EXCEPTION 'Cannot delete class "%" because students are currently enrolled in it.',
      OLD.name;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cbt_exams_raw
    WHERE class = OLD.name
  ) THEN
    RAISE EXCEPTION 'Cannot delete class "%" because active or scheduled examinations are assigned to it.',
      OLD.name;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS protect_class_deletion_trigger ON public.classes;
CREATE TRIGGER protect_class_deletion_trigger
  BEFORE DELETE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.protect_class_deletion();

-- 3. Ensure student_results and active_sessions reference valid exams on insertion
CREATE OR REPLACE FUNCTION public.validate_result_exam_reference()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.cbt_exams_raw WHERE id::text = NEW.exam_id
  ) THEN
    RAISE EXCEPTION 'Referential integrity violation: exam_id "%" does not exist in cbt_exams_raw', NEW.exam_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_result_exam_reference_trigger ON public.student_results;
CREATE TRIGGER validate_result_exam_reference_trigger
  BEFORE INSERT OR UPDATE OF exam_id ON public.student_results
  FOR EACH ROW EXECUTE FUNCTION public.validate_result_exam_reference();

DROP TRIGGER IF EXISTS validate_active_session_exam_reference_trigger ON public.active_sessions;
CREATE TRIGGER validate_active_session_exam_reference_trigger
  BEFORE INSERT OR UPDATE OF exam_id ON public.active_sessions
  FOR EACH ROW EXECUTE FUNCTION public.validate_result_exam_reference();
