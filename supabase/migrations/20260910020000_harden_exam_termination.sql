-- A candidate may terminate only their own assigned, already-started attempt.
-- The transaction lock also makes termination idempotent across tabs/devices.

CREATE OR REPLACE FUNCTION public.terminate_exam(exam_id_param uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row public.cbt_exams_raw%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  total_questions integer := 0;
  marks_correct numeric;
BEGIN
  SELECT * INTO student_row FROM public.students WHERE id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(student_row.student_id || ':' || exam_id_param::text, 0));

  IF EXISTS (
    SELECT 1 FROM public.student_results
    WHERE student_id = student_row.student_id AND exam_id = exam_id_param::text
  ) THEN
    RETURN;
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND OR exam_row.status NOT IN ('ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'This exam is not available';
  END IF;
  IF NOT (exam_row.class IS NULL OR exam_row.class = 'All' OR exam_row.class = student_row.class)
     OR NOT (exam_row.section IS NULL OR exam_row.section = 'All' OR exam_row.section = student_row.section) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  SELECT * INTO session_row FROM public.active_sessions
  WHERE id = student_row.id::text || '_' || exam_id_param::text;
  IF NOT FOUND OR session_row.started_at IS NULL THEN
    RAISE EXCEPTION 'Exam session was not started correctly';
  END IF;

  SELECT count(*) INTO total_questions
  FROM jsonb_each(COALESCE((SELECT answers FROM public.cbt_exam_answers WHERE exam_id = exam_id_param), '{}'::jsonb));
  marks_correct := COALESCE((exam_row.questions_data->>'marksCorrect')::numeric, 4);

  INSERT INTO public.student_results (
    exam_id, student_id, student_name, total_score, max_score,
    correct, incorrect, unattempted, subject_scores, submitted_at
  ) VALUES (
    exam_id_param::text, student_row.student_id, student_row.name, 0,
    total_questions * marks_correct, 0, 0, total_questions, '{}'::jsonb, now()
  ) ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions WHERE id = session_row.id;
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_exam(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_exam(uuid) TO authenticated;
