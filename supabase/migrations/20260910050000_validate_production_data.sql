-- Reject malformed records even when an administrator bypasses the web form.

CREATE OR REPLACE FUNCTION public.validate_student_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.student_id !~ '^[A-Za-z0-9._-]{2,64}$'
     OR length(btrim(NEW.name)) NOT BETWEEN 1 AND 120
     OR (NEW.class IS NOT NULL AND length(btrim(NEW.class)) NOT BETWEEN 1 AND 120)
     OR (NEW.section IS NOT NULL AND length(btrim(NEW.section)) NOT BETWEEN 1 AND 32) THEN
    RAISE EXCEPTION 'Student identity data is invalid';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS validate_student_record_trigger ON public.students;
CREATE TRIGGER validate_student_record_trigger
  BEFORE INSERT OR UPDATE OF student_id, name, class, section ON public.students
  FOR EACH ROW EXECUTE FUNCTION public.validate_student_record();

ALTER TABLE public.classes DROP CONSTRAINT IF EXISTS classes_data_valid;
ALTER TABLE public.classes ADD CONSTRAINT classes_data_valid CHECK (
  length(btrim(name)) BETWEEN 1 AND 120
  AND cardinality(sections) > 0
  AND array_position(sections, '') IS NULL
) NOT VALID;

ALTER TABLE public.question_bank DROP CONSTRAINT IF EXISTS question_bank_data_valid;
ALTER TABLE public.question_bank ADD CONSTRAINT question_bank_data_valid CHECK (
  type IN ('MCQ', 'NUMERICAL', 'NAT')
  AND length(btrim(subject)) BETWEEN 1 AND 120
  AND (
    (type = 'MCQ' AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4 AND correct_answer IN ('0', '1', '2', '3'))
    OR
    (type IN ('NUMERICAL', 'NAT') AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 0
      AND correct_answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$')
  )
) NOT VALID;

ALTER TABLE public.cbt_exams_raw DROP CONSTRAINT IF EXISTS cbt_exams_data_valid;
ALTER TABLE public.cbt_exams_raw ADD CONSTRAINT cbt_exams_data_valid CHECK (
  length(btrim(title)) BETWEEN 1 AND 200
  AND jsonb_typeof(questions_data) = 'object'
  AND jsonb_typeof(questions_data->'subjects') = 'array'
  AND jsonb_array_length(questions_data->'subjects') > 0
  AND jsonb_typeof(questions_data->'questions') = 'object'
  AND COALESCE(questions_data->>'duration', '') ~ '^[0-9]+$'
  AND (questions_data->>'duration')::integer BETWEEN 1 AND 600
  AND COALESCE(questions_data->>'marksCorrect', '') ~ '^[+]?[0-9]+([.][0-9]+)?$'
  AND (questions_data->>'marksCorrect')::numeric BETWEEN 0 AND 100
  AND COALESCE(questions_data->>'marksIncorrect', '') ~ '^-?[0-9]+([.][0-9]+)?$'
  AND (questions_data->>'marksIncorrect')::numeric BETWEEN -100 AND 0
) NOT VALID;
