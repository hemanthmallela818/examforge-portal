


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."admin_clear_question_bank"("confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required' USING ERRCODE = '42501';
  END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR QUESTION BANK' THEN
    RAISE EXCEPTION 'Exact question-bank confirmation is required';
  END IF;

  LOCK TABLE public.question_bank IN EXCLUSIVE MODE;
  SELECT count(*)::integer INTO deleted_count FROM public.question_bank;
  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'CLEAR_QUESTION_BANK', 'question_bank', NULL,
    jsonb_build_object('deleted_count', deleted_count,
                       'asset_disposition', 'retained_for_exam_snapshot_safety')
  );
  DELETE FROM public.question_bank WHERE true;
  RETURN jsonb_build_object('deleted', deleted_count);
END;
$$;


ALTER FUNCTION "public"."admin_clear_question_bank"("confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_deactivate_students"("user_ids_param" "uuid"[], "reason_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  student_row public.students%ROWTYPE;
  affected_count integer := 0;
  requested_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  requested_count := cardinality(user_ids_param);
  IF requested_count IS NULL OR requested_count < 1 OR requested_count > 100 THEN
    RAISE EXCEPTION 'Select between 1 and 100 students';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(user_ids_param) AS selected(id) WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(user_ids_param) AS selected(id)) <> requested_count THEN
    RAISE EXCEPTION 'Student selection contains invalid or duplicate IDs';
  END IF;
  IF reason_param IS NULL OR length(btrim(reason_param)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'A deactivation reason between 3 and 500 characters is required';
  END IF;

  FOR student_row IN
    SELECT * FROM public.students
    WHERE id = ANY(user_ids_param)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF student_row.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Student % is already inactive', student_row.student_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.active_sessions a WHERE a.student_id = student_row.student_id) THEN
      RAISE EXCEPTION 'Student % has an active examination attempt and cannot be deactivated', student_row.student_id;
    END IF;

    UPDATE public.students
    SET archived_at = clock_timestamp(), archived_by = auth.uid(),
        archive_reason = btrim(reason_param), active_auth_session_id = NULL
    WHERE id = student_row.id;

    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      auth.uid(), 'DEACTIVATE_STUDENT', 'student', student_row.id::text,
      jsonb_build_object('student_id', student_row.student_id, 'name', student_row.name,
                         'reason', btrim(reason_param))
    );
    affected_count := affected_count + 1;
  END LOOP;

  IF affected_count <> requested_count THEN
    RAISE EXCEPTION 'One or more selected students were not found';
  END IF;
  RETURN jsonb_build_object('deactivated', affected_count);
END;
$$;


ALTER FUNCTION "public"."admin_deactivate_students"("user_ids_param" "uuid"[], "reason_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_empty_class"("class_id_param" "uuid", "expected_name_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  class_row public.classes%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  SELECT * INTO class_row FROM public.classes WHERE id = class_id_param FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Class was not found';
  END IF;
  IF expected_name_param IS DISTINCT FROM class_row.name THEN
    RAISE EXCEPTION 'Class name confirmation did not match';
  END IF;
  IF EXISTS (SELECT 1 FROM public.students WHERE class = class_row.name) THEN
    RAISE EXCEPTION 'Cannot delete a class with active or inactive student records';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cbt_exams_raw WHERE class = class_row.name) THEN
    RAISE EXCEPTION 'Cannot delete a class referenced by an examination';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_EMPTY_CLASS', 'class', class_row.id::text,
    jsonb_build_object('name', class_row.name, 'sections', class_row.sections)
  );
  DELETE FROM public.classes WHERE id = class_row.id;
  RETURN jsonb_build_object('deleted', true, 'class_id', class_row.id);
END;
$$;


ALTER FUNCTION "public"."admin_delete_empty_class"("class_id_param" "uuid", "expected_name_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_exam_template"("template_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  existing public.exam_templates%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  DELETE FROM public.exam_templates AS t WHERE t.id = template_id_param RETURNING * INTO existing;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pattern not found'; END IF;
  -- Exams created from this pattern keep their own copy of its structure.
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DELETE_EXAM_TEMPLATE', 'exam_template', existing.id::text, jsonb_build_object('name', existing.name));
  RETURN jsonb_build_object('deleted', true);
END;
$$;


ALTER FUNCTION "public"."admin_delete_exam_template"("template_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_question"("question_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  question_row public.question_bank%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  SELECT * INTO question_row FROM public.question_bank
  WHERE id = question_id_param FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question was not found';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_QUESTION', 'question_bank', question_row.id::text,
    jsonb_build_object('subject', question_row.subject, 'type', question_row.type)
  );
  DELETE FROM public.question_bank WHERE id = question_row.id;
  RETURN jsonb_build_object('deleted', true, 'question_id', question_row.id);
END;
$$;


ALTER FUNCTION "public"."admin_delete_question"("question_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_subject"("subject_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  existing public.subjects%ROWTYPE;
  usage jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));
  SELECT * INTO existing FROM public.subjects AS s WHERE s.id = subject_id_param FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subject not found'; END IF;
  usage := public.subject_usage(existing.name);
  IF (usage->>'questions')::integer > 0 OR (usage->>'templates')::integer > 0 OR (usage->>'exams')::integer > 0 THEN
    RAISE EXCEPTION 'Subject "%" is used by % question(s), % pattern(s) and % exam(s), so it cannot be deleted. Deactivate it instead.',
      existing.name, usage->>'questions', usage->>'templates', usage->>'exams';
  END IF;
  IF (SELECT count(*) FROM public.subjects AS s WHERE s.is_active AND s.id <> existing.id) = 0 THEN
    RAISE EXCEPTION 'At least one active subject must remain';
  END IF;
  DELETE FROM public.subjects AS s WHERE s.id = existing.id;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DELETE_SUBJECT', 'subject', existing.id::text, jsonb_build_object('name', existing.name));
  RETURN jsonb_build_object('deleted', true);
END;
$$;


ALTER FUNCTION "public"."admin_delete_subject"("subject_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_unused_exam"("exam_id_param" "uuid", "expected_title_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  IF exam_id_param IS NULL OR expected_title_param IS NULL THEN
    RAISE EXCEPTION 'Exam ID and exact title confirmation are required';
  END IF;

  SELECT * INTO exam_row
  FROM public.cbt_exams_raw
  WHERE id = exam_id_param
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam was not found';
  END IF;
  IF expected_title_param IS DISTINCT FROM exam_row.title THEN
    RAISE EXCEPTION 'Exam title confirmation did not match';
  END IF;
  IF exam_row.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'Cannot delete an active exam. End the exam first.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = exam_id_param::text) THEN
    RAISE EXCEPTION 'Cannot delete an exam with submitted results';
  END IF;
  IF EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = exam_id_param::text) THEN
    RAISE EXCEPTION 'Cannot delete an exam with student attempts';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    auth.uid(), 'DELETE_UNUSED_EXAM', 'cbt_exam', exam_id_param::text,
    jsonb_build_object('title', exam_row.title, 'status', exam_row.status)
  );

  PERFORM set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  DELETE FROM public.cbt_exams_raw WHERE id = exam_id_param;

  RETURN jsonb_build_object('deleted', true, 'exam_id', exam_id_param);
END;
$$;


ALTER FUNCTION "public"."admin_delete_unused_exam"("exam_id_param" "uuid", "expected_title_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_finalize_expired_sessions"("batch_limit_param" integer DEFAULT 100) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access is required';
  END IF;
  RETURN public.finalize_expired_sessions_internal(batch_limit_param, 0, auth.uid(), 'administrator');
END;
$$;


ALTER FUNCTION "public"."admin_finalize_expired_sessions"("batch_limit_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_import_questions"("batch_id_param" "uuid", "file_name_param" "text", "questions_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  actor_id uuid := auth.uid();
  item jsonb;
  option_value jsonb;
  item_type text;
  item_subject text;
  item_text text;
  item_answer text;
  item_options jsonb;
  item_count integer;
  request_hash text;
  existing_batch public.question_import_batches%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF batch_id_param IS NULL THEN RAISE EXCEPTION 'Import batch ID is required'; END IF;
  IF length(btrim(COALESCE(file_name_param, ''))) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'File name must contain between 1 and 255 characters';
  END IF;
  IF jsonb_typeof(questions_param) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Questions payload must be a JSON array';
  END IF;
  item_count := jsonb_array_length(questions_param);
  IF item_count NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Import must contain between 1 and 500 questions'; END IF;
  IF octet_length(convert_to(questions_param::text, 'UTF8')) > 5242880 THEN
    RAISE EXCEPTION 'Import payload must not exceed 5 MB';
  END IF;

  request_hash := md5(questions_param::text);
  LOCK TABLE public.question_import_batches IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO existing_batch FROM public.question_import_batches WHERE batch_id = batch_id_param;
  IF FOUND THEN
    IF existing_batch.imported_by IS DISTINCT FROM actor_id OR existing_batch.payload_hash IS DISTINCT FROM request_hash THEN
      RAISE EXCEPTION 'Import batch ID was already used for a different request';
    END IF;
    RETURN jsonb_build_object('imported', existing_batch.question_count, 'idempotent', true, 'batch_id', batch_id_param);
  END IF;

  LOCK TABLE public.question_bank IN SHARE ROW EXCLUSIVE MODE;
  PERFORM set_config('cbt.question_import_batch', 'on', true);
  FOR item IN SELECT value FROM jsonb_array_elements(questions_param) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Every question must be a JSON object'; END IF;
    IF (item - ARRAY['subject','type','question_text','options','correct_answer','has_image_or_diagram','category','points','neg_points']::text[]) <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Question contains unsupported fields';
    END IF;
    item_type := item->>'type';
    item_subject := item->>'subject';
    item_text := btrim(COALESCE(item->>'question_text', ''));
    item_answer := btrim(COALESCE(item->>'correct_answer', ''));
    item_options := item->'options';

    SELECT configured.name INTO item_subject
    FROM public.subjects AS configured
    WHERE lower(configured.name) = lower(btrim(COALESCE(item->>'subject', ''))) AND configured.is_active;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invalid question subject'; END IF;
    IF item_type NOT IN ('MCQ', 'NUMERICAL') THEN RAISE EXCEPTION 'Invalid question type'; END IF;
    IF length(item_text) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Question text must contain between 1 and 10000 characters'; END IF;
    IF jsonb_typeof(item->'has_image_or_diagram') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Image indicator must be boolean'; END IF;
    IF COALESCE((item->>'points')::integer, 0) <> 4 OR COALESCE((item->>'neg_points')::integer, 0) <> -1 THEN
      RAISE EXCEPTION 'Imported JEE questions must use +4/-1 scoring';
    END IF;

    IF item_type = 'MCQ' THEN
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 4 OR item_answer !~ '^[0-3]$' THEN
        RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
      END IF;
      FOR option_value IN SELECT value FROM jsonb_array_elements(item_options) LOOP
        IF jsonb_typeof(option_value) IS DISTINCT FROM 'string'
           OR length(btrim(option_value #>> '{}')) NOT BETWEEN 1 AND 5000 THEN
          RAISE EXCEPTION 'Every MCQ option must contain between 1 and 5000 characters';
        END IF;
      END LOOP;
      IF (SELECT count(DISTINCT public.canonical_question_text(value #>> '{}')) FROM jsonb_array_elements(item_options)) <> 4 THEN
        RAISE EXCEPTION 'MCQ options must be unique';
      END IF;
    ELSE
      IF jsonb_typeof(item_options) IS DISTINCT FROM 'array' OR jsonb_array_length(item_options) <> 0
         OR length(item_answer) NOT BETWEEN 1 AND 100
         OR item_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
        RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.question_bank WHERE public.canonical_question_text(question_text) = public.canonical_question_text(item_text)) THEN
      RAISE EXCEPTION 'A matching question already exists in the Question Bank';
    END IF;

    INSERT INTO public.question_bank (
      subject, type, question_text, options, correct_answer, has_image_or_diagram, category, points, neg_points
    ) VALUES (
      item_subject, item_type, item_text, item_options, item_answer,
      (item->>'has_image_or_diagram')::boolean, COALESCE(NULLIF(btrim(item->>'category'), ''), 'Mains'), 4, -1
    );
  END LOOP;

  INSERT INTO public.question_import_batches (batch_id, imported_by, payload_hash, file_name, question_count)
  VALUES (batch_id_param, actor_id, request_hash, btrim(file_name_param), item_count);
  INSERT INTO public.import_history (file_name, total_questions, successful_imports, rejected_questions, status)
  VALUES (btrim(file_name_param), item_count, item_count, 0, 'Success');
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (actor_id, 'IMPORT_QUESTIONS', 'question_import_batch', batch_id_param::text,
          jsonb_build_object('file_name', btrim(file_name_param), 'question_count', item_count));

  RETURN jsonb_build_object('imported', item_count, 'idempotent', false, 'batch_id', batch_id_param);
END;
$_$;


ALTER FUNCTION "public"."admin_import_questions"("batch_id_param" "uuid", "file_name_param" "text", "questions_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_exam_templates"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'description', t.description,
      'durationMinutes', t.duration_minutes,
      'marksCorrect', t.marks_correct, 'marksIncorrect', t.marks_incorrect,
      'sections', t.sections, 'isActive', t.is_active,
      'totalQuestions', (SELECT COALESCE(sum((s->>'questionCount')::integer), 0) FROM jsonb_array_elements(t.sections) AS s),
      'inactiveSubjects', (
        SELECT COALESCE(jsonb_agg(s->>'subject'), '[]'::jsonb)
        FROM jsonb_array_elements(t.sections) AS s
        WHERE NOT EXISTS (SELECT 1 FROM public.subjects AS sub
                          WHERE lower(sub.name) = lower(s->>'subject') AND sub.is_active)
      ),
      'updatedAt', t.updated_at
    ) ORDER BY lower(t.name))
    FROM public.exam_templates AS t
  ), '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."admin_list_exam_templates"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_subjects"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'displayOrder', s.display_order, 'isActive', s.is_active,
      'usage', public.subject_usage(s.name)
    ) ORDER BY s.display_order, lower(s.name))
    FROM public.subjects AS s
  ), '[]'::jsonb);
END;
$$;


ALTER FUNCTION "public"."admin_list_subjects"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_operational_health"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  active_exam_count integer;
  live_session_count integer;
  expired_session_count integer;
  incomplete_media_count integer;
  inactive_student_count integer;
  recent_audit_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  SELECT count(*)::integer INTO active_exam_count FROM public.cbt_exams_raw WHERE status = 'ACTIVE';
  SELECT count(*)::integer INTO live_session_count FROM public.active_sessions WHERE deadline_at > clock_timestamp();
  SELECT count(*)::integer INTO expired_session_count FROM public.active_sessions WHERE deadline_at <= clock_timestamp();
  SELECT count(*)::integer INTO inactive_student_count FROM public.students WHERE archived_at IS NOT NULL;
  SELECT count(*)::integer INTO recent_audit_count FROM public.admin_audit_events WHERE occurred_at >= clock_timestamp() - interval '24 hours';

  SELECT count(*)::integer INTO incomplete_media_count
  FROM public.question_bank
  WHERE has_image_or_diagram = true AND length(btrim(COALESCE(question_image_url, ''))) = 0;

  RETURN jsonb_build_object(
    'status', CASE WHEN expired_session_count > 0 OR incomplete_media_count > 0 THEN 'ATTENTION' ELSE 'HEALTHY' END,
    'checked_at', clock_timestamp(),
    'active_exams', active_exam_count,
    'live_sessions', live_session_count,
    'expired_sessions_pending_finalization', expired_session_count,
    'questions_missing_required_media', incomplete_media_count,
    'inactive_students', inactive_student_count,
    'audit_events_last_24_hours', recent_audit_count
  );
END;
$$;


ALTER FUNCTION "public"."admin_operational_health"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reactivate_students"("user_ids_param" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  student_row public.students%ROWTYPE;
  affected_count integer := 0;
  requested_count integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  requested_count := cardinality(user_ids_param);
  IF requested_count IS NULL OR requested_count < 1 OR requested_count > 100 THEN
    RAISE EXCEPTION 'Select between 1 and 100 students';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(user_ids_param) AS selected(id) WHERE id IS NULL)
    OR (SELECT count(DISTINCT id) FROM unnest(user_ids_param) AS selected(id)) <> requested_count THEN
    RAISE EXCEPTION 'Student selection contains invalid or duplicate IDs';
  END IF;

  FOR student_row IN
    SELECT * FROM public.students
    WHERE id = ANY(user_ids_param)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF student_row.archived_at IS NULL THEN
      RAISE EXCEPTION 'Student % is already active', student_row.student_id;
    END IF;

    UPDATE public.students
    SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
        active_auth_session_id = NULL
    WHERE id = student_row.id;

    INSERT INTO public.admin_audit_events (
      actor_user_id, action, target_type, target_id, metadata
    ) VALUES (
      auth.uid(), 'REACTIVATE_STUDENT', 'student', student_row.id::text,
      jsonb_build_object('student_id', student_row.student_id, 'name', student_row.name)
    );
    affected_count := affected_count + 1;
  END LOOP;

  IF affected_count <> requested_count THEN
    RAISE EXCEPTION 'One or more selected students were not found';
  END IF;
  RETURN jsonb_build_object('reactivated', affected_count);
END;
$$;


ALTER FUNCTION "public"."admin_reactivate_students"("user_ids_param" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reorder_subjects"("ordered_ids_param" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  expected integer;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));
  SELECT count(*) INTO expected FROM public.subjects;
  IF ordered_ids_param IS NULL
     OR cardinality(ordered_ids_param) <> expected
     OR (SELECT count(DISTINCT x) FROM unnest(ordered_ids_param) AS x) <> expected
     OR EXISTS (SELECT 1 FROM unnest(ordered_ids_param) AS x WHERE NOT EXISTS (SELECT 1 FROM public.subjects AS s WHERE s.id = x)) THEN
    RAISE EXCEPTION 'The subject list changed while you were reordering. Reload and try again.';
  END IF;
  UPDATE public.subjects AS s
  SET display_order = o.position, updated_at = now()
  FROM unnest(ordered_ids_param) WITH ORDINALITY AS o(id, position)
  WHERE s.id = o.id;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'REORDER_SUBJECTS', 'subject', NULL, jsonb_build_object('count', expected));
  RETURN jsonb_build_object('reordered', expected);
END;
$$;


ALTER FUNCTION "public"."admin_reorder_subjects"("ordered_ids_param" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_save_exam_template"("template_id_param" "uuid", "name_param" "text", "description_param" "text", "duration_minutes_param" integer, "marks_correct_param" numeric, "marks_incorrect_param" numeric, "sections_param" "jsonb", "is_active_param" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  cleaned_name text := regexp_replace(btrim(COALESCE(name_param, '')), '\s+', ' ', 'g');
  cleaned_description text := btrim(COALESCE(description_param, ''));
  normalized_sections jsonb;
  saved public.exam_templates%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  IF length(cleaned_name) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Pattern name must be between 1 and 80 characters'; END IF;
  IF length(cleaned_description) > 500 THEN RAISE EXCEPTION 'Description can be at most 500 characters'; END IF;
  IF duration_minutes_param IS NULL OR duration_minutes_param NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Duration must be between 1 and 600 minutes';
  END IF;
  IF marks_correct_param IS NULL OR marks_correct_param <= 0 OR marks_correct_param > 100 THEN
    RAISE EXCEPTION 'Marks for a correct answer must be greater than 0 and at most 100';
  END IF;
  IF marks_incorrect_param IS NULL OR marks_incorrect_param NOT BETWEEN -100 AND 0 THEN
    RAISE EXCEPTION 'Marks for a wrong answer must be between -100 and 0';
  END IF;
  IF round(marks_correct_param, 2) <> marks_correct_param OR round(marks_incorrect_param, 2) <> marks_incorrect_param THEN
    RAISE EXCEPTION 'Marks can have at most two decimal places';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));
  normalized_sections := public.normalize_exam_template_sections(sections_param);

  IF EXISTS (SELECT 1 FROM public.exam_templates AS t
             WHERE lower(t.name) = lower(cleaned_name) AND t.id IS DISTINCT FROM template_id_param) THEN
    RAISE EXCEPTION 'A pattern named "%" already exists', cleaned_name;
  END IF;

  IF template_id_param IS NULL THEN
    INSERT INTO public.exam_templates (name, description, duration_minutes, marks_correct, marks_incorrect, sections, is_active)
    VALUES (cleaned_name, cleaned_description, duration_minutes_param, marks_correct_param, marks_incorrect_param,
            normalized_sections, COALESCE(is_active_param, true))
    RETURNING * INTO saved;
  ELSE
    UPDATE public.exam_templates AS t
    SET name = cleaned_name, description = cleaned_description, duration_minutes = duration_minutes_param,
        marks_correct = marks_correct_param, marks_incorrect = marks_incorrect_param,
        sections = normalized_sections, is_active = COALESCE(is_active_param, true), updated_at = now()
    WHERE t.id = template_id_param
    RETURNING * INTO saved;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pattern not found'; END IF;
  END IF;

  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), CASE WHEN template_id_param IS NULL THEN 'CREATE_EXAM_TEMPLATE' ELSE 'UPDATE_EXAM_TEMPLATE' END,
          'exam_template', saved.id::text,
          jsonb_build_object('name', saved.name, 'sections', jsonb_array_length(saved.sections), 'is_active', saved.is_active));
  RETURN jsonb_build_object('id', saved.id, 'name', saved.name);
END;
$$;


ALTER FUNCTION "public"."admin_save_exam_template"("template_id_param" "uuid", "name_param" "text", "description_param" "text", "duration_minutes_param" integer, "marks_correct_param" numeric, "marks_incorrect_param" numeric, "sections_param" "jsonb", "is_active_param" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_save_subject"("subject_id_param" "uuid", "name_param" "text", "is_active_param" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  cleaned_name text;
  existing public.subjects%ROWTYPE;
  usage jsonb;
  saved public.subjects%ROWTYPE;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access is required'; END IF;
  cleaned_name := public.assert_subject_name(name_param);
  PERFORM pg_advisory_xact_lock(hashtextextended('examforge:subjects', 0));

  IF EXISTS (SELECT 1 FROM public.subjects AS s
             WHERE lower(s.name) = lower(cleaned_name)
               AND s.id IS DISTINCT FROM subject_id_param) THEN
    RAISE EXCEPTION 'A subject named "%" already exists', cleaned_name;
  END IF;

  IF subject_id_param IS NULL THEN
    INSERT INTO public.subjects (name, display_order, is_active)
    VALUES (cleaned_name,
            COALESCE((SELECT max(s.display_order) + 1 FROM public.subjects AS s), 1),
            COALESCE(is_active_param, true))
    RETURNING * INTO saved;
    INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'CREATE_SUBJECT', 'subject', saved.id::text, jsonb_build_object('name', saved.name));
  ELSE
    SELECT * INTO existing FROM public.subjects AS s WHERE s.id = subject_id_param FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Subject not found'; END IF;
    usage := public.subject_usage(existing.name);

    -- Questions, patterns and immutable exam snapshots store the subject name, so a
    -- subject that is in use keeps its exact name (even letter case).
    IF cleaned_name IS DISTINCT FROM existing.name
       AND ((usage->>'questions')::integer > 0 OR (usage->>'templates')::integer > 0 OR (usage->>'exams')::integer > 0) THEN
      RAISE EXCEPTION 'Subject "%" is already used by % question(s), % pattern(s) and % exam(s), so it cannot be renamed. Create a new subject instead.',
        existing.name, usage->>'questions', usage->>'templates', usage->>'exams';
    END IF;

    IF COALESCE(is_active_param, true) = false AND existing.is_active
       AND (usage->>'activeTemplates')::integer > 0 THEN
      RAISE EXCEPTION 'Subject "%" is used by % active pattern(s). Remove it from those patterns or deactivate them first.',
        existing.name, usage->>'activeTemplates';
    END IF;

    UPDATE public.subjects AS s
    SET name = cleaned_name, is_active = COALESCE(is_active_param, true), updated_at = now()
    WHERE s.id = subject_id_param
    RETURNING * INTO saved;
    INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'UPDATE_SUBJECT', 'subject', saved.id::text,
            jsonb_build_object('name', saved.name, 'previous_name', existing.name, 'is_active', saved.is_active));
  END IF;

  RETURN jsonb_build_object('id', saved.id, 'name', saved.name, 'displayOrder', saved.display_order, 'isActive', saved.is_active);
END;
$$;


ALTER FUNCTION "public"."admin_save_subject"("subject_id_param" "uuid", "name_param" "text", "is_active_param" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_student_assignment"("student_user_id_param" "uuid", "class_name_param" "text", "section_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  student_row public.students%ROWTYPE;
  clean_class text := btrim(COALESCE(class_name_param, ''));
  clean_section text := btrim(COALESCE(section_param, ''));
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.classes WHERE name = clean_class AND sections @> ARRAY[clean_section]) THEN
    RAISE EXCEPTION 'The selected class and section do not exist';
  END IF;
  SELECT * INTO student_row FROM public.students WHERE id = student_user_id_param FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Student was not found'; END IF;
  IF student_row.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Inactive student assignments cannot be changed'; END IF;

  UPDATE public.students SET class = clean_class, section = clean_section WHERE id = student_user_id_param;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'UPDATE_STUDENT_ASSIGNMENT', 'student', student_user_id_param::text,
          jsonb_build_object('previous_class', student_row.class, 'previous_section', student_row.section,
                             'class', clean_class, 'section', clean_section));
  RETURN jsonb_build_object('id', student_user_id_param, 'class', clean_class, 'section', clean_section);
END;
$$;


ALTER FUNCTION "public"."admin_update_student_assignment"("student_user_id_param" "uuid", "class_name_param" "text", "section_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_current_student_session"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  expected_session_id pg_catalog.uuid;
  caller_user_id pg_catalog.uuid;
BEGIN
  caller_user_id := auth.uid();
  expected_session_id := public.current_auth_session_id();

  IF caller_user_id IS NULL OR expected_session_id IS NULL THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active' USING ERRCODE = 'EX001';
  END IF;

  -- Held until the caller transaction ends, closing the check-then-write race
  -- between automatic takeover and start/autosave/submit/terminate operations.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      caller_user_id::pg_catalog.text OPERATOR(pg_catalog.||) ':student-session-claim',
      0
    )
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.students AS s
    WHERE s.id OPERATOR(pg_catalog.=) caller_user_id
      AND s.archived_at IS NULL
      AND s.active_auth_session_id OPERATOR(pg_catalog.=) expected_session_id
  ) THEN
    RAISE EXCEPTION 'This student session has been replaced or is no longer active' USING ERRCODE = 'EX001';
  END IF;
END;
$$;


ALTER FUNCTION "public"."assert_current_student_session"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_exam_payload_bounds"("questions_data_param" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
DECLARE
  questions_obj pg_catalog.jsonb;
  subject_entry pg_catalog.record;
  question_item pg_catalog.jsonb;
  total_questions pg_catalog.int4 := 0;
BEGIN
  IF questions_data_param IS NULL THEN
    RETURN;
  END IF;

  IF pg_catalog.octet_length(questions_data_param::pg_catalog.text)
    OPERATOR(pg_catalog.>) 8388608
  THEN
    RAISE EXCEPTION 'Exam payload must not exceed 8 MiB';
  END IF;

  questions_obj := questions_data_param -> 'questions';
  IF pg_catalog.jsonb_typeof(questions_obj) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.jsonb_object_keys(questions_obj)
  ) OPERATOR(pg_catalog.>) 10 THEN
    RAISE EXCEPTION 'Exam payload must not contain more than 10 subject groups';
  END IF;

  FOR subject_entry IN
    SELECT item.key, item.value
    FROM pg_catalog.jsonb_each(questions_obj) AS item
  LOOP
    IF pg_catalog.octet_length(subject_entry.key) OPERATOR(pg_catalog.>) 120 THEN
      RAISE EXCEPTION 'Exam subject name must not exceed 120 bytes';
    END IF;
    IF pg_catalog.jsonb_typeof(subject_entry.value) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    total_questions := total_questions
      OPERATOR(pg_catalog.+) pg_catalog.jsonb_array_length(subject_entry.value);
    IF total_questions OPERATOR(pg_catalog.>) 500 THEN
      RAISE EXCEPTION 'Exam payload must contain no more than 500 questions';
    END IF;

    FOR question_item IN
      SELECT item.value
      FROM pg_catalog.jsonb_array_elements(subject_entry.value) AS item(value)
    LOOP
      IF pg_catalog.octet_length(question_item::pg_catalog.text)
        OPERATOR(pg_catalog.>) 65536
      THEN
        RAISE EXCEPTION 'An individual exam question must not exceed 64 KiB';
      END IF;
    END LOOP;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."assert_exam_payload_bounds"("questions_data_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_exam_required_media"("questions_data_param" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  subject_name text;
  question_item jsonb;
BEGIN
  IF jsonb_typeof(questions_data_param->'questions') IS DISTINCT FROM 'object' THEN RETURN; END IF;
  FOR subject_name IN SELECT jsonb_object_keys(questions_data_param->'questions') LOOP
    FOR question_item IN SELECT value FROM jsonb_array_elements(questions_data_param->'questions'->subject_name) LOOP
      IF COALESCE((question_item->>'hasImageOrDiagram')::boolean, false)
         AND length(btrim(COALESCE(question_item->>'questionImageUrl', question_item->>'imageUrl', ''))) = 0 THEN
        RAISE EXCEPTION 'Exam validation failed: question "%" is marked as requiring an image or diagram but none is attached', COALESCE(question_item->>'id', 'unknown');
      END IF;
    END LOOP;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."assert_exam_required_media"("questions_data_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_subject_name"("name_param" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO ''
    AS $_$
DECLARE
  cleaned text := regexp_replace(btrim(COALESCE(name_param, '')), '\s+', ' ', 'g');
BEGIN
  IF length(cleaned) = 0 THEN RAISE EXCEPTION 'Enter a subject name'; END IF;
  IF length(cleaned) > 60 THEN RAISE EXCEPTION 'Subject names can be at most 60 characters'; END IF;
  IF cleaned !~ '^[[:alnum:]][[:alnum:] &().,/+''-]*$' THEN
    RAISE EXCEPTION 'Subject names may contain letters, numbers, spaces and & ( ) . , / + '' - only, and must start with a letter or number';
  END IF;
  RETURN cleaned;
END;
$_$;


ALTER FUNCTION "public"."assert_subject_name"("name_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_class_admin_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_aal2() THEN RETURN NEW; END IF;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), CASE WHEN TG_OP = 'INSERT' THEN 'CREATE_CLASS' ELSE 'UPDATE_CLASS' END,
          'class', NEW.id::text, jsonb_build_object('name', NEW.name, 'sections', NEW.sections));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."audit_class_admin_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_exam_admin_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  action_name text;
  question_count integer := 0;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_aal2() THEN RETURN NEW; END IF;
  action_name := CASE
    WHEN TG_OP = 'INSERT' THEN 'CREATE_EXAM'
    WHEN OLD.status IS DISTINCT FROM NEW.status THEN 'CHANGE_EXAM_STATUS'
    ELSE 'UPDATE_EXAM'
  END;
  SELECT COALESCE(sum(jsonb_array_length(CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END)), 0)::integer
    INTO question_count
  FROM jsonb_each(CASE WHEN jsonb_typeof(NEW.questions_data->'questions') = 'object' THEN NEW.questions_data->'questions' ELSE '{}'::jsonb END);
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), action_name, 'cbt_exam', NEW.id::text,
          jsonb_build_object('title', NEW.title, 'previous_status', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
                             'status', NEW.status, 'class', NEW.class, 'section', NEW.section, 'question_count', question_count));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."audit_exam_admin_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_provisioned_student"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  actor_text text;
  actor_id uuid;
BEGIN
  SELECT raw_app_meta_data->>'provisioned_by_user' INTO actor_text FROM auth.users WHERE id = NEW.id;
  IF actor_text IS NULL OR actor_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN NEW; END IF;
  actor_id := actor_text::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = actor_id AND role = 'admin') THEN RETURN NEW; END IF;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (actor_id, 'PROVISION_STUDENT', 'student', NEW.id::text,
          jsonb_build_object('student_id', NEW.student_id, 'class', NEW.class, 'section', NEW.section));
  RETURN NEW;
END;
$_$;


ALTER FUNCTION "public"."audit_provisioned_student"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."audit_question_admin_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_aal2() THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND current_setting('cbt.question_import_batch', true) = 'on' THEN RETURN NEW; END IF;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), CASE WHEN TG_OP = 'INSERT' THEN 'CREATE_QUESTION' ELSE 'UPDATE_QUESTION' END,
          'question_bank', NEW.id::text,
          jsonb_build_object('subject', NEW.subject, 'type', NEW.type, 'has_image', NEW.question_image_url IS NOT NULL));
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."audit_question_admin_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."block_direct_cbt_exams_raw_writes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF current_setting('cbt.trusted_exam_context', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Direct modification of table % is prohibited. All exam modifications must be executed through the public.cbt_exams view.', TG_TABLE_NAME;
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."block_direct_cbt_exams_raw_writes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."build_session_response_schema"("paper_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO ''
    AS $$
  SELECT pg_catalog.jsonb_build_object(
    'subjects', COALESCE(paper_param -> 'subjects', '[]'::pg_catalog.jsonb),
    'duration', paper_param -> 'duration',
    'questions', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(
        subject.key,
        CASE WHEN pg_catalog.jsonb_typeof(subject.value) OPERATOR(pg_catalog.=) 'array' THEN (
          SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'type', question.item -> 'type',
              'options', CASE WHEN pg_catalog.jsonb_typeof(question.item -> 'options') OPERATOR(pg_catalog.=) 'array' THEN (
                SELECT COALESCE(pg_catalog.jsonb_agg('null'::pg_catalog.jsonb), '[]'::pg_catalog.jsonb)
                FROM pg_catalog.jsonb_array_elements(question.item -> 'options')
              ) ELSE question.item -> 'options' END
            ) ORDER BY question.position
          ), '[]'::pg_catalog.jsonb)
          FROM pg_catalog.jsonb_array_elements(subject.value) WITH ORDINALITY AS question(item, position)
        ) ELSE subject.value END
      )
      FROM pg_catalog.jsonb_each(paper_param -> 'questions') AS subject
      WHERE pg_catalog.jsonb_typeof(paper_param -> 'questions') OPERATOR(pg_catalog.=) 'object'
    ), '{}'::pg_catalog.jsonb)
  );
$$;


ALTER FUNCTION "public"."build_session_response_schema"("paper_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."canonical_question_text"("value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE STRICT PARALLEL SAFE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  SELECT lower(regexp_replace(btrim(normalize(value, NFKC)), '[[:space:]]+', ' ', 'g'))
$$;


ALTER FUNCTION "public"."canonical_question_text"("value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."capture_student_result_review"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  session_row public.active_sessions%ROWTYPE;
BEGIN
  SELECT session.*
  INTO session_row
  FROM public.active_sessions AS session
  WHERE session.exam_id OPERATOR(pg_catalog.=) NEW.exam_id
    AND session.student_id OPERATOR(pg_catalog.=) NEW.student_id
  ORDER BY session.updated_at DESC NULLS LAST
  LIMIT 1;

  IF session_row.id IS NOT NULL THEN
    INSERT INTO public.student_result_reviews (
      result_id,
      exam_id,
      student_id,
      response_snapshot,
      subject_time_seconds
    ) VALUES (
      NEW.id,
      NEW.exam_id::pg_catalog.uuid,
      NEW.student_id,
      COALESCE(session_row.user_responses, '{}'::pg_catalog.jsonb),
      COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb)
    )
    ON CONFLICT (result_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."capture_student_result_review"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_student_session"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  claimed_session_id pg_catalog.uuid;
  previous_session_id pg_catalog.uuid;
  replaced_existing_session pg_catalog.bool := false;
  student_row public.students%ROWTYPE;
BEGIN
  claimed_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR claimed_session_id IS NULL THEN
    RAISE EXCEPTION 'A valid authenticated Supabase session is required' USING ERRCODE = 'EX004';
  END IF;

  -- This same transaction lock is acquired by every authoritative student
  -- exam operation. A claim therefore happens wholly before or after a write.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      auth.uid()::pg_catalog.text OPERATOR(pg_catalog.||) ':student-session-claim',
      0
    )
  );

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student profile not found' USING ERRCODE = 'EX002';
  END IF;
  IF student_row.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This student account is inactive' USING ERRCODE = 'EX003';
  END IF;

  previous_session_id := student_row.active_auth_session_id;
  replaced_existing_session := previous_session_id IS NOT NULL
    AND previous_session_id OPERATOR(pg_catalog.<>) claimed_session_id;

  UPDATE public.students AS s
  SET active_auth_session_id = claimed_session_id
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid();

  IF replaced_existing_session THEN
    INSERT INTO public.admin_audit_events (
      actor_user_id,
      action,
      target_type,
      target_id,
      metadata
    ) VALUES (
      auth.uid(),
      'STUDENT_SESSION_TAKEOVER',
      'student',
      auth.uid()::pg_catalog.text,
      '{}'::pg_catalog.jsonb
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'session_id', claimed_session_id,
    'replaced_existing_session', replaced_existing_session,
    'student_id', student_row.student_id,
    'name', student_row.name,
    'class', student_row.class,
    'section', student_row.section
  );
END;
$$;


ALTER FUNCTION "public"."claim_student_session"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_student_session"() IS 'Atomically authorizes the caller JWT session for student operations. Returns only the new/current session ID and a takeover boolean; never the replaced session ID.';



CREATE OR REPLACE FUNCTION "public"."cleanup_unreferenced_exam_assets"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  RAISE EXCEPTION 'Direct database cleanup is disabled; delete files through the Supabase Storage API';
END;
$$;


ALTER FUNCTION "public"."cleanup_unreferenced_exam_assets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_account_provisioning"("account_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  account_row record;
  account_type text;
  account_name text;
  existing_role text;
BEGIN
  IF (SELECT auth.role()) OPERATOR(pg_catalog.<>) 'service_role' THEN
    RAISE EXCEPTION 'Service-role account provisioning is required';
  END IF;
  IF account_id_param IS NULL THEN
    RAISE EXCEPTION 'Account ID is required';
  END IF;

  SELECT id, email, raw_app_meta_data, raw_user_meta_data
  INTO account_row
  FROM auth.users
  WHERE id OPERATOR(pg_catalog.=) account_id_param
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth account not found'; END IF;

  IF COALESCE(account_row.raw_app_meta_data OPERATOR(pg_catalog.->>) 'provisioned_by', '')
       OPERATOR(pg_catalog.<>) 'admin' THEN
    RAISE EXCEPTION 'Auth account is missing its server-owned provisioning marker';
  END IF;
  account_type := COALESCE(account_row.raw_app_meta_data OPERATOR(pg_catalog.->>) 'account_type', '');
  IF account_type NOT IN ('student', 'admin') THEN
    RAISE EXCEPTION 'A valid server-owned account type is required';
  END IF;

  account_name := COALESCE(
    NULLIF(pg_catalog.btrim(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name'), ''),
    pg_catalog.split_part(account_row.email, '@', 1)
  );

  SELECT role INTO existing_role FROM public.profiles WHERE id OPERATOR(pg_catalog.=) account_id_param;
  IF FOUND AND existing_role OPERATOR(pg_catalog.<>) account_type THEN
    RAISE EXCEPTION 'Existing application profile has a conflicting account type';
  END IF;

  INSERT INTO public.profiles (id, email, name, role)
  VALUES (account_id_param, account_row.email, account_name, account_type)
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    name = EXCLUDED.name;

  IF account_type OPERATOR(pg_catalog.=) 'student' THEN
    IF COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section', '') OPERATOR(pg_catalog.=) '' THEN
      RAISE EXCEPTION 'Student provisioning metadata is incomplete';
    END IF;

    INSERT INTO public.students (id, student_id, name, class, section)
    VALUES (
      account_id_param,
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id',
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name',
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class',
      account_row.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section'
    )
    ON CONFLICT (id) DO UPDATE SET
      student_id = EXCLUDED.student_id,
      name = EXCLUDED.name,
      class = EXCLUDED.class,
      section = EXCLUDED.section;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', account_id_param,
    'account_type', account_type,
    'provisioned', true
  );
END;
$$;


ALTER FUNCTION "public"."complete_account_provisioning"("account_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_auth_session_id"() RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
DECLARE
  raw_session_id pg_catalog.text;
BEGIN
  raw_session_id := NULLIF(auth.jwt() ->> 'session_id', '');
  IF raw_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN raw_session_id::pg_catalog.uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END;
$$;


ALTER FUNCTION "public"."current_auth_session_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_students"("user_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  user_id uuid;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to delete students';
  END IF;

  FOREACH user_id IN ARRAY COALESCE(user_ids, ARRAY[]::uuid[]) LOOP
    PERFORM public.delete_user(user_id);
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."delete_students"("user_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_user"("user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  public_student_id text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to delete users';
  END IF;

  SELECT student_id INTO public_student_id FROM public.students WHERE id = user_id;
  IF public_student_id IS NOT NULL THEN
    DELETE FROM public.active_sessions WHERE student_id = public_student_id;
    DELETE FROM public.student_results WHERE student_id = public_student_id;
  END IF;
  DELETE FROM auth.users WHERE id = user_id;
END;
$$;


ALTER FUNCTION "public"."delete_user"("user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."exam_progress_to_submission"("progress" "jsonb", "paper_questions" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  canonical jsonb;
  output jsonb := '[]'::jsonb;
  subject_name text;
  question_item jsonb;
  response_item jsonb;
  idx integer;
BEGIN
  canonical := public.sanitize_exam_responses(progress, paper_questions);
  FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
    idx := 0;
    FOR question_item IN SELECT value FROM jsonb_array_elements(paper_questions->subject_name) LOOP
      response_item := canonical->subject_name->idx;
      output := output || jsonb_build_array(jsonb_build_object(
        'question_id', question_item->>'id',
        'selected_option', response_item->'selectedOption',
        'status', response_item->>'status'
      ));
      idx := idx + 1;
    END LOOP;
  END LOOP;
  RETURN output;
END;
$$;


ALTER FUNCTION "public"."exam_progress_to_submission"("progress" "jsonb", "paper_questions" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."exam_questions_for_viewer"("p_exam_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  v_qdata   jsonb;
  v_answers jsonb;
  v_class   text;
  v_section text;
BEGIN
  SELECT r.questions_data, a.answers, r.class, r.section
    INTO v_qdata, v_answers, v_class, v_section
  FROM public.cbt_exams_raw r
  LEFT JOIN public.cbt_exam_answers a ON a.exam_id = r.id
  WHERE r.id = p_exam_id;

  -- No such exam, or an exam with no stored paper.
  IF NOT FOUND OR v_qdata IS NULL THEN
    RETURN NULL;
  END IF;

  -- Admins with a verified MFA (AAL2) session get the full reconstructed
  -- paper (answers re-injected), exactly as the previous view CASE branch did.
  IF public.is_admin_aal2() THEN
    RETURN public.reconstruct_exam_questions(v_qdata, v_answers);
  END IF;

  -- Non-admins: only assigned, non-archived students may see the metadata,
  -- and NEVER the `questions` array. This predicate is a faithful mirror of
  -- the cbt_exams_read_assigned RLS policy (20260910190000) so this function
  -- is no more permissive than direct row access to the base table, and is
  -- therefore safe to expose directly as a PostgREST RPC.
  IF NOT EXISTS (
    SELECT 1 FROM public.students s
    WHERE s.id = auth.uid()
      AND s.archived_at IS NULL
      AND (v_class IS NULL OR v_class = 'All' OR s.class = v_class)
      AND (v_section IS NULL OR v_section = 'All' OR s.section = v_section)
  ) THEN
    RETURN NULL;
  END IF;

  -- Strip the questions array: students receive exam metadata only (subjects,
  -- marks, duration, ...), never the questions themselves. The ONLY path to
  -- the questions remains start_exam_session() after a legitimate start.
  RETURN v_qdata - 'questions';
END;
$$;


ALTER FUNCTION "public"."exam_questions_for_viewer"("p_exam_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."exam_questions_for_viewer"("p_exam_id" "uuid") IS 'B-3 manifest: returns questions_data for the answer-safe cbt_exams view without granting authenticated column access to cbt_exams_raw.questions_data. Admin-AAL2 -> reconstructed paper; assigned student -> questions_data minus the questions key; otherwise NULL. Mirrors the cbt_exams_read_assigned RLS predicate so it is safe to expose as an RPC.';



CREATE OR REPLACE FUNCTION "public"."finalize_expired_sessions_internal"("batch_limit_param" integer, "grace_seconds_param" integer, "actor_id_param" "uuid", "source_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  previous_sub pg_catalog.text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  candidate record;
  student_user_id pg_catalog.uuid;
  finalized_count pg_catalog.int4 := 0;
  skipped_count pg_catalog.int4 := 0;
  failed_count pg_catalog.int4 := 0;
BEGIN
  IF batch_limit_param IS NULL OR batch_limit_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Batch limit must be between 1 and 500';
  END IF;

  FOR candidate IN
    SELECT s.id, s.student_id, s.exam_id, s.deadline_at
    FROM public.active_sessions AS s
    WHERE s.deadline_at IS NOT NULL
      AND s.deadline_at OPERATOR(pg_catalog.<=) (
        pg_catalog.clock_timestamp() OPERATOR(pg_catalog.-)
          pg_catalog.make_interval(secs => GREATEST(grace_seconds_param, 0))
      )
    ORDER BY s.deadline_at, s.id
    LIMIT batch_limit_param
  LOOP
    BEGIN
      IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended(
          candidate.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) candidate.exam_id,
          0
        )
      ) THEN
        skipped_count := skipped_count OPERATOR(pg_catalog.+) 1;
        CONTINUE;
      END IF;

      PERFORM 1 FROM public.active_sessions AS s
      WHERE s.id OPERATOR(pg_catalog.=) candidate.id
      FOR UPDATE NOWAIT;
      IF NOT FOUND THEN
        -- The candidate submitted between the scan and the lock.
        CONTINUE;
      END IF;

      SELECT st.id INTO student_user_id
      FROM public.students AS st
      WHERE st.student_id OPERATOR(pg_catalog.=) candidate.student_id
        AND st.archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Expired session % has no active student record', candidate.id;
      END IF;

      -- Reuse the private, server-authoritative grader. Only the local
      -- transaction claim changes, and it is restored below.
      PERFORM pg_catalog.set_config('request.jwt.claim.sub', student_user_id::pg_catalog.text, true);
      PERFORM public.submit_exam_stage3_internal(candidate.exam_id::pg_catalog.uuid, '[]'::pg_catalog.jsonb);
      DELETE FROM public.active_sessions AS s WHERE s.id OPERATOR(pg_catalog.=) candidate.id;
      PERFORM pg_catalog.set_config('request.jwt.claim.sub', COALESCE(previous_sub, ''), true);

      INSERT INTO public.admin_audit_events (
        actor_user_id, action, target_type, target_id, metadata
      ) VALUES (
        actor_id_param, 'FINALIZE_EXPIRED_SESSION', 'active_session', candidate.id,
        pg_catalog.jsonb_build_object(
          'student_id', candidate.student_id,
          'exam_id', candidate.exam_id,
          'deadline_at', candidate.deadline_at,
          'source', source_param
        )
      );
      finalized_count := finalized_count OPERATOR(pg_catalog.+) 1;
    EXCEPTION
      WHEN lock_not_available THEN
        skipped_count := skipped_count OPERATOR(pg_catalog.+) 1;
      WHEN OTHERS THEN
        -- One broken attempt must not block every other candidate's result.
        failed_count := failed_count OPERATOR(pg_catalog.+) 1;
        RAISE WARNING 'finalize_expired_session_failed session=% sqlstate=% message=%',
          candidate.id, SQLSTATE, SQLERRM;
    END;
  END LOOP;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', COALESCE(previous_sub, ''), true);
  RETURN pg_catalog.jsonb_build_object(
    'finalized', finalized_count,
    'skipped', skipped_count,
    'failed', failed_count
  );
END;
$$;


ALTER FUNCTION "public"."finalize_expired_sessions_internal"("batch_limit_param" integer, "grace_seconds_param" integer, "actor_id_param" "uuid", "source_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_exam_list_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text" DEFAULT NULL::"text", "status_param" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  normalized_status text := NULLIF(upper(btrim(COALESCE(status_param, ''))), '');
  total_count integer;
  page_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 100';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Exam search must not exceed 100 characters';
  END IF;
  IF normalized_status IS NOT NULL AND normalized_status NOT IN ('PENDING', 'ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'Exam status filter is invalid';
  END IF;

  SELECT count(*)::integer INTO total_count
  FROM public.cbt_exams_raw exam
  WHERE (normalized_status IS NULL OR exam.status = normalized_status)
    AND (
      normalized_search IS NULL
      OR position(lower(normalized_search) in lower(exam.title)) > 0
      OR position(lower(normalized_search) in lower(COALESCE(exam.class, ''))) > 0
      OR position(lower(normalized_search) in lower(COALESCE(exam.section, ''))) > 0
    );

  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.created_at DESC, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT exam.created_at, exam.id,
      jsonb_build_object(
        'id', exam.id,
        'title', exam.title,
        'status', exam.status,
        'class', exam.class,
        'section', exam.section,
        'created_at', exam.created_at,
        'duration', exam.questions_data->>'duration',
        'total_questions', exam.questions_data->>'totalQuestions',
        'subjects', COALESCE(exam.questions_data->'subjects', '[]'::jsonb)
      ) AS payload
    FROM public.cbt_exams_raw exam
    WHERE (normalized_status IS NULL OR exam.status = normalized_status)
      AND (
        normalized_search IS NULL
        OR position(lower(normalized_search) in lower(exam.title)) > 0
        OR position(lower(normalized_search) in lower(COALESCE(exam.class, ''))) > 0
        OR position(lower(normalized_search) in lower(COALESCE(exam.section, ''))) > 0
      )
    ORDER BY exam.created_at DESC, exam.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object('page', page_number_param, 'page_size', page_size_param, 'total', total_count, 'rows', page_rows);
END;
$$;


ALTER FUNCTION "public"."get_admin_exam_list_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "status_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_exam_results_export_page"("exam_id_param" "uuid", "after_student_id_param" "text", "page_size_param" integer, "expected_result_count_param" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO ''
    AS $$
DECLARE
  exam_subjects jsonb;
  overall_count integer;
  page_rows jsonb;
  has_more boolean;
  next_cursor text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Active administrator access is required';
  END IF;
  IF exam_id_param IS NULL THEN RAISE EXCEPTION 'Exam ID is required'; END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Export page size must be between 1 and 500';
  END IF;
  IF expected_result_count_param IS NULL OR expected_result_count_param NOT BETWEEN 1 AND 20000 THEN
    RAISE EXCEPTION 'Expected result count must be between 1 and 20000';
  END IF;

  SELECT exam.questions_data->'subjects' INTO exam_subjects
  FROM public.cbt_exams exam WHERE exam.id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam was not found'; END IF;
  IF jsonb_typeof(exam_subjects) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Exam subjects are invalid'; END IF;

  SELECT count(*)::integer INTO overall_count
  FROM public.student_results result WHERE result.exam_id = exam_id_param::text;
  IF overall_count IS DISTINCT FROM expected_result_count_param THEN
    RAISE EXCEPTION 'Result set changed: expected %, found %. Restart the export.', expected_result_count_param, overall_count;
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.payload ORDER BY candidate.student_id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT result.student_id,
      jsonb_build_object(
        'id', result.id,
        'exam_id', result.exam_id,
        'student_id', result.student_id,
        'student_name', result.student_name,
        'total_score', result.total_score,
        'max_score', result.max_score,
        'correct', result.correct,
        'incorrect', result.incorrect,
        'unattempted', result.unattempted,
        'subject_scores', result.subject_scores,
        'submitted_at', result.submitted_at
      ) AS payload
    FROM public.student_results result
    WHERE result.exam_id = exam_id_param::text
      AND (after_student_id_param IS NULL OR result.student_id > after_student_id_param)
    ORDER BY result.student_id
    LIMIT page_size_param + 1
  ) AS candidate;

  has_more := jsonb_array_length(page_rows) > page_size_param;
  IF has_more THEN page_rows := page_rows - page_size_param; END IF;
  next_cursor := CASE WHEN jsonb_array_length(page_rows) = 0 THEN NULL ELSE page_rows->-1->>'student_id' END;

  RETURN jsonb_build_object(
    'result_count', overall_count,
    'subjects', exam_subjects,
    'rows', page_rows,
    'has_more', has_more,
    'next_student_id', next_cursor
  );
END;
$$;


ALTER FUNCTION "public"."get_admin_exam_results_export_page"("exam_id_param" "uuid", "after_student_id_param" "text", "page_size_param" integer, "expected_result_count_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_exam_results_page"("exam_id_param" "uuid", "page_number_param" integer, "page_size_param" integer, "search_param" "text" DEFAULT NULL::"text", "expected_result_count_param" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  exam_subjects jsonb;
  overall_count integer;
  filtered_count integer;
  page_rows jsonb;
  analytics_payload jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF exam_id_param IS NULL THEN RAISE EXCEPTION 'Exam ID is required'; END IF;
  IF page_number_param IS NULL OR page_number_param NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'Page number must be between 0 and 100000';
  END IF;
  IF page_size_param IS NULL OR page_size_param NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 500';
  END IF;
  IF normalized_search IS NOT NULL AND length(normalized_search) > 100 THEN
    RAISE EXCEPTION 'Result search must not exceed 100 characters';
  END IF;
  IF expected_result_count_param IS NOT NULL AND expected_result_count_param NOT BETWEEN 0 AND 20000 THEN
    RAISE EXCEPTION 'Expected result count must be between 0 and 20000';
  END IF;

  SELECT exam.questions_data->'subjects' INTO exam_subjects
  FROM public.cbt_exams exam WHERE exam.id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam was not found'; END IF;
  IF jsonb_typeof(exam_subjects) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Exam subjects are invalid';
  END IF;

  SELECT count(*)::integer INTO overall_count
  FROM public.student_results result WHERE result.exam_id = exam_id_param::text;
  IF expected_result_count_param IS NOT NULL AND overall_count IS DISTINCT FROM expected_result_count_param THEN
    RAISE EXCEPTION 'Result set changed: expected %, found %. Restart the export.', expected_result_count_param, overall_count;
  END IF;

  WITH base AS (
    SELECT result.*,
      rank() OVER (ORDER BY result.total_score DESC)::integer AS total_rank
    FROM public.student_results result
    WHERE result.exam_id = exam_id_param::text
  )
  SELECT count(*)::integer INTO filtered_count
  FROM base result
  WHERE normalized_search IS NULL
    OR position(lower(normalized_search) in lower(result.student_id)) > 0
    OR position(lower(normalized_search) in lower(COALESCE(result.student_name, ''))) > 0;

  WITH subjects AS (
    SELECT subject.value AS subject
    FROM jsonb_array_elements_text(exam_subjects) WITH ORDINALITY AS subject(value, position)
  ), base AS (
    SELECT result.*,
      rank() OVER (ORDER BY result.total_score DESC)::integer AS total_rank
    FROM public.student_results result
    WHERE result.exam_id = exam_id_param::text
  ), subject_expanded AS (
    SELECT result.id, subject.subject,
      COALESCE(NULLIF(result.subject_scores->>subject.subject, ''), '0')::numeric AS subject_score
    FROM base result CROSS JOIN subjects subject
  ), subject_ranked AS (
    SELECT expanded.*,
      rank() OVER (PARTITION BY expanded.subject ORDER BY expanded.subject_score DESC)::integer AS subject_rank
    FROM subject_expanded expanded
  ), subject_maps AS (
    SELECT ranked.id,
      jsonb_object_agg(ranked.subject, to_jsonb(ranked.subject_rank)) AS subject_ranks
    FROM subject_ranked ranked GROUP BY ranked.id
  ), filtered AS (
    SELECT result.*, COALESCE(maps.subject_ranks, '{}'::jsonb) AS subject_ranks
    FROM base result LEFT JOIN subject_maps maps ON maps.id = result.id
    WHERE normalized_search IS NULL
      OR position(lower(normalized_search) in lower(result.student_id)) > 0
      OR position(lower(normalized_search) in lower(COALESCE(result.student_name, ''))) > 0
  )
  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.total_score DESC, page_row.student_id, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT result.total_score, result.student_id, result.id,
      jsonb_build_object(
        'id', result.id,
        'exam_id', result.exam_id,
        'student_id', result.student_id,
        'student_name', result.student_name,
        'total_score', result.total_score,
        'max_score', result.max_score,
        'correct', result.correct,
        'incorrect', result.incorrect,
        'unattempted', result.unattempted,
        'subject_scores', result.subject_scores,
        'subject_ranks', result.subject_ranks,
        'total_rank', result.total_rank,
        'submitted_at', result.submitted_at
      ) AS payload
    FROM filtered result
    ORDER BY result.total_score DESC, result.student_id, result.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  WITH subjects AS (
    SELECT subject.value AS subject, subject.position
    FROM jsonb_array_elements_text(exam_subjects) WITH ORDINALITY AS subject(value, position)
  ), results AS (
    SELECT result.* FROM public.student_results result WHERE result.exam_id = exam_id_param::text
  ), subject_averages AS (
    SELECT subject.subject, subject.position,
      COALESCE(avg(COALESCE(NULLIF(result.subject_scores->>subject.subject, ''), '0')::numeric), 0) AS score
    FROM subjects subject LEFT JOIN results result ON true
    GROUP BY subject.subject, subject.position
  )
  SELECT CASE WHEN overall_count = 0 THEN NULL ELSE jsonb_build_object(
    'average_score', (SELECT avg(result.total_score) FROM results result),
    'highest_score', (SELECT max(result.total_score) FROM results result),
    'lowest_score', (SELECT min(result.total_score) FROM results result),
    'excluded_from_distribution', (SELECT count(*) FROM results result WHERE result.max_score <= 0),
    'distribution', jsonb_build_array(
      jsonb_build_object('name', '0-20%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 <= 20)),
      jsonb_build_object('name', '21-40%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 20 AND result.total_score / result.max_score * 100 <= 40)),
      jsonb_build_object('name', '41-60%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 40 AND result.total_score / result.max_score * 100 <= 60)),
      jsonb_build_object('name', '61-80%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 60 AND result.total_score / result.max_score * 100 <= 80)),
      jsonb_build_object('name', '81-100%', 'count', (SELECT count(*) FROM results result WHERE result.max_score > 0 AND result.total_score / result.max_score * 100 > 80))
    ),
    'subject_averages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('name', average.subject, 'score', average.score) ORDER BY average.position), '[]'::jsonb) FROM subject_averages average)
  ) END INTO analytics_payload;

  RETURN jsonb_build_object(
    'page', page_number_param,
    'page_size', page_size_param,
    'total', filtered_count,
    'result_count', overall_count,
    'subjects', exam_subjects,
    'analytics', analytics_payload,
    'rows', page_rows
  );
END;
$$;


ALTER FUNCTION "public"."get_admin_exam_results_page"("exam_id_param" "uuid", "page_number_param" integer, "page_size_param" integer, "search_param" "text", "expected_result_count_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_question_bank_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text" DEFAULT NULL::"text", "subject_param" "text" DEFAULT NULL::"text", "type_param" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  normalized_search text := NULLIF(btrim(COALESCE(search_param, '')), '');
  normalized_subject text := NULLIF(btrim(COALESCE(subject_param, '')), '');
  normalized_type text := NULLIF(upper(btrim(COALESCE(type_param, ''))), '');
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
    RAISE EXCEPTION 'Question search must not exceed 100 characters';
  END IF;
  IF normalized_subject IS NOT NULL AND length(normalized_subject) > 100 THEN
    RAISE EXCEPTION 'Subject filter must not exceed 100 characters';
  END IF;
  IF normalized_type IS NOT NULL AND normalized_type NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
    RAISE EXCEPTION 'Question type filter is invalid';
  END IF;

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  )
  SELECT count(*)::integer INTO total_count
  FROM numbered question
  WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
    AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE 'MCQ' END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)
    AND (
      normalized_search IS NULL
      OR position(lower(normalized_search) in lower(question.question_text)) > 0
      OR position(lower(normalized_search) in lower(question.subject)) > 0
      OR position(normalized_search in question.question_number::text) > 0
    );

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  ), filtered AS (
    SELECT question.*,
      COALESCE((
        SELECT configured.display_order FROM public.subjects AS configured
        WHERE lower(configured.name) = lower(question.subject)
      ), 1000000) AS subject_sort
    FROM numbered question
    WHERE (normalized_subject IS NULL OR question.subject = normalized_subject)
      AND (normalized_type IS NULL OR CASE WHEN upper(question.type) IN ('NAT', 'NUMERICAL') THEN 'NUMERICAL' ELSE 'MCQ' END = CASE WHEN normalized_type = 'NAT' THEN 'NUMERICAL' ELSE normalized_type END)
      AND (
        normalized_search IS NULL
        OR position(lower(normalized_search) in lower(question.question_text)) > 0
        OR position(lower(normalized_search) in lower(question.subject)) > 0
        OR position(normalized_search in question.question_number::text) > 0
      )
  )
  SELECT COALESCE(jsonb_agg(page_row.payload ORDER BY page_row.subject_sort, page_row.subject, page_row.question_number, page_row.id), '[]'::jsonb)
  INTO page_rows
  FROM (
    SELECT question.subject_sort, question.subject, question.question_number, question.id,
      jsonb_build_object(
        'id', question.id,
        'subject', question.subject,
        'type', question.type,
        'question_number', question.question_number,
        'question_text', question.question_text,
        'options', question.options,
        'correct_answer', question.correct_answer,
        'question_image_url', question.question_image_url,
        'option_image_urls', question.option_image_urls,
        'has_image_or_diagram', question.has_image_or_diagram,
        'created_at', question.created_at
      ) AS payload
    FROM filtered question
    ORDER BY question.subject_sort, question.subject, question.question_number, question.id
    OFFSET page_number_param * page_size_param
    LIMIT page_size_param
  ) AS page_row;

  RETURN jsonb_build_object('page', page_number_param, 'page_size', page_size_param, 'total', total_count, 'rows', page_rows);
END;
$$;


ALTER FUNCTION "public"."get_admin_question_bank_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "subject_param" "text", "type_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_questions_by_ids"("question_ids_param" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  requested_count integer;
  selected_rows jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  requested_count := COALESCE(cardinality(question_ids_param), 0);
  IF requested_count NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Between 1 and 500 question IDs are required';
  END IF;
  IF array_position(question_ids_param, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT id) FROM unnest(question_ids_param) AS id) <> requested_count THEN
    RAISE EXCEPTION 'Question IDs must be unique and non-null';
  END IF;

  WITH numbered AS (
    SELECT question.*,
      row_number() OVER (PARTITION BY question.subject ORDER BY question.created_at, question.id)::integer AS question_number
    FROM public.question_bank question
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', question.id,
    'subject', question.subject,
    'type', question.type,
    'question_number', question.question_number,
    'question_text', question.question_text,
    'options', question.options,
    'correct_answer', question.correct_answer,
    'question_image_url', question.question_image_url,
    'option_image_urls', question.option_image_urls,
    'has_image_or_diagram', question.has_image_or_diagram,
    'created_at', question.created_at
  ) ORDER BY requested.ordinality), '[]'::jsonb)
  INTO selected_rows
  FROM unnest(question_ids_param) WITH ORDINALITY AS requested(id, ordinality)
  JOIN numbered question ON question.id = requested.id;

  RETURN jsonb_build_object('requested_count', requested_count, 'rows', selected_rows);
END;
$$;


ALTER FUNCTION "public"."get_admin_questions_by_ids"("question_ids_param" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_student_result_review"("result_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  review_row public.student_result_reviews%ROWTYPE;
  exam_paper pg_catalog.jsonb;
  answer_keys pg_catalog.jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Active administrator access is required';
  END IF;
  IF result_id_param IS NULL THEN RAISE EXCEPTION 'Result ID is required'; END IF;

  SELECT review.* INTO review_row
  FROM public.student_result_reviews AS review
  WHERE review.result_id OPERATOR(pg_catalog.=) result_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Detailed answer review is unavailable for this submission';
  END IF;

  SELECT exam.questions_data, answer.answers
  INTO exam_paper, answer_keys
  FROM public.cbt_exams_raw AS exam
  JOIN public.cbt_exam_answers AS answer
    ON answer.exam_id OPERATOR(pg_catalog.=) exam.id
  WHERE exam.id OPERATOR(pg_catalog.=) review_row.exam_id;
  IF NOT FOUND OR exam_paper IS NULL OR answer_keys IS NULL THEN
    RAISE EXCEPTION 'The immutable exam paper or answer key is unavailable';
  END IF;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    target_type,
    target_id,
    metadata
  ) VALUES (
    auth.uid(),
    'VIEW_STUDENT_ANSWER_REVIEW',
    'student_result',
    result_id_param::pg_catalog.text,
    pg_catalog.jsonb_build_object('exam_id', review_row.exam_id, 'student_id', review_row.student_id)
  );

  RETURN pg_catalog.jsonb_build_object(
    'result_id', review_row.result_id,
    'exam_id', review_row.exam_id,
    'student_id', review_row.student_id,
    'responses', review_row.response_snapshot,
    'paper', exam_paper,
    'answer_key', answer_keys,
    'subject_time_seconds', review_row.subject_time_seconds,
    'created_at', review_row.created_at
  );
END;
$$;


ALTER FUNCTION "public"."get_admin_student_result_review"("result_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_student_roster_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text" DEFAULT NULL::"text", "class_param" "text" DEFAULT NULL::"text", "section_param" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
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


ALTER FUNCTION "public"."get_admin_student_roster_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "class_param" "text", "section_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_db_size"() RETURNS TABLE("table_name" "text", "size_bytes" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  RETURN QUERY
  SELECT c.relname::pg_catalog.text,
    pg_catalog.pg_total_relation_size(c.oid)::pg_catalog.int8
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n
    ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
  WHERE n.nspname OPERATOR(pg_catalog.=) 'public'
    AND c.relkind OPERATOR(pg_catalog.=) 'r'
  ORDER BY c.relname;
END;
$$;


ALTER FUNCTION "public"."get_db_size"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_role"() RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT CASE WHEN p.role = 'admin' THEN
    CASE WHEN public.is_admin_aal2() THEN 'admin' ELSE NULL END
    ELSE p.role END FROM public.profiles p WHERE p.id = auth.uid();
$$;


ALTER FUNCTION "public"."get_my_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_student_exam_result"("exam_id_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  student_row public.students%ROWTYPE;
  result_row public.student_results%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF exam_id_param IS NULL
    OR pg_catalog.octet_length(exam_id_param) OPERATOR(pg_catalog.<) 1
    OR pg_catalog.octet_length(exam_id_param) OPERATOR(pg_catalog.>) 128
  THEN
    RAISE EXCEPTION 'Invalid exam identifier';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$$;


ALTER FUNCTION "public"."get_student_exam_result"("exam_id_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_unreferenced_exam_assets"() RETURNS TABLE("name" "text", "id" "text", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  RETURN QUERY
  SELECT o.name::pg_catalog.text,
    o.id::pg_catalog.text,
    o.created_at
  FROM storage.objects AS o
  WHERE o.bucket_id OPERATOR(pg_catalog.=) 'exam-assets'
    AND NOT public.is_exam_asset_referenced(o.name)
  ORDER BY o.created_at, o.name
  LIMIT 500;
END;
$$;


ALTER FUNCTION "public"."get_unreferenced_exam_assets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_cbt_exams_modification"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  clean_questions jsonb := '{}'::jsonb;
  answers_obj jsonb := '{}'::jsonb;
  subject_name text;
  question_obj jsonb;
  clean_subject_questions jsonb;
  clean_qdata jsonb;
  ans_val text;
  has_attempts boolean := false;
  preflight_res jsonb;
BEGIN
  IF NOT public.is_admin_aal2() THEN RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required to modify exams'; END IF;
  PERFORM set_config('cbt.trusted_exam_context', 'on', true);
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.status NOT IN ('PENDING', 'ACTIVE', 'ENDED') THEN RAISE EXCEPTION 'Invalid exam lifecycle status'; END IF;
  IF TG_OP = 'UPDATE' THEN
    has_attempts := EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text)
                 OR EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text);
    IF has_attempts AND OLD.status = 'ENDED' AND NEW.status <> 'ENDED' THEN RAISE EXCEPTION 'Cannot reactivate an ended exam that has student attempts or results'; END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
      (OLD.status = 'PENDING' AND NEW.status = 'ACTIVE') OR (OLD.status = 'ACTIVE' AND NEW.status = 'ENDED')
      OR (OLD.status = 'ENDED' AND NEW.status = 'ACTIVE' AND NOT has_attempts)
    ) THEN RAISE EXCEPTION 'Invalid exam lifecycle transition from % to %', OLD.status, NEW.status; END IF;
    IF has_attempts AND (OLD.questions_data IS DISTINCT FROM NEW.questions_data OR OLD.class IS DISTINCT FROM NEW.class OR OLD.section IS DISTINCT FROM NEW.section) THEN
      RAISE EXCEPTION 'Cannot modify exam questions, duration, scoring, or assignment after student attempts have begun';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_OP = 'UPDATE' AND NEW.questions_data IS NOT DISTINCT FROM OLD.questions_data THEN
      IF NEW.title IS NULL OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters'; END IF;
      IF OLD.status <> 'ACTIVE' AND NEW.status = 'ACTIVE' THEN
        preflight_res := public.preflight_validate_exam(NEW.id);
        IF NOT (preflight_res->>'valid')::boolean THEN
          RAISE EXCEPTION 'Cannot activate exam "%": preflight validation failed with % error(s). First error: %', NEW.title, jsonb_array_length(preflight_res->'errors'), preflight_res->'errors'->>0;
        END IF;
      END IF;
      UPDATE public.cbt_exams_raw SET title = NEW.title, status = NEW.status, questions_data = OLD.questions_data, class = NEW.class, section = NEW.section WHERE id = NEW.id;
      RETURN NEW;
    END IF;
    PERFORM public.validate_full_exam_paper(NEW.title, NEW.questions_data);
    FOR subject_name IN SELECT jsonb_object_keys(NEW.questions_data->'questions') LOOP
      clean_subject_questions := '[]'::jsonb;
      FOR question_obj IN SELECT value FROM jsonb_array_elements(NEW.questions_data->'questions'->subject_name) LOOP
        ans_val := btrim(COALESCE(question_obj->>'correctAnswer', question_obj->>'correct_answer', ''));
        IF upper(ans_val) IN ('A', 'B', 'C', 'D') THEN ans_val := (ascii(upper(ans_val)) - 65)::text; END IF;
        answers_obj := jsonb_set(answers_obj, ARRAY[question_obj->>'id'], jsonb_build_object('correct_answer', ans_val, 'subject', subject_name, 'type', upper(COALESCE(question_obj->>'type', 'MCQ'))), true);
        clean_subject_questions := clean_subject_questions || jsonb_build_array(question_obj - 'correctAnswer' - 'correct_answer');
      END LOOP;
      clean_questions := jsonb_set(clean_questions, ARRAY[subject_name], clean_subject_questions, true);
    END LOOP;
    clean_qdata := jsonb_set(NEW.questions_data, '{questions}', clean_questions, true);
    IF TG_OP = 'INSERT' THEN
      NEW.id := COALESCE(NEW.id, gen_random_uuid());
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section, created_at)
      VALUES (NEW.id, NEW.title, COALESCE(NEW.status, 'PENDING'), clean_qdata, NEW.class, NEW.section, COALESCE(NEW.created_at, clock_timestamp()));
    ELSE
      UPDATE public.cbt_exams_raw SET title = NEW.title, status = NEW.status, questions_data = clean_qdata, class = NEW.class, section = NEW.section WHERE id = NEW.id;
    END IF;
    INSERT INTO public.cbt_exam_answers (exam_id, answers) VALUES (NEW.id, answers_obj)
      ON CONFLICT (exam_id) DO UPDATE SET answers = EXCLUDED.answers;
    IF NEW.status = 'ACTIVE' THEN
      preflight_res := public.preflight_validate_exam(NEW.id);
      IF NOT (preflight_res->>'valid')::boolean THEN
        RAISE EXCEPTION 'Cannot activate exam "%": preflight validation failed with % error(s). First error: %', NEW.title, jsonb_array_length(preflight_res->'errors'), preflight_res->'errors'->>0;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ACTIVE' THEN RAISE EXCEPTION 'Cannot delete an active exam. End the exam first.'; END IF;
    IF EXISTS (SELECT 1 FROM public.student_results WHERE exam_id = OLD.id::text) THEN RAISE EXCEPTION 'Cannot delete exam % because student submission results exist', OLD.id; END IF;
    IF EXISTS (SELECT 1 FROM public.active_sessions WHERE exam_id = OLD.id::text) THEN RAISE EXCEPTION 'Cannot delete exam % because active student attempts exist', OLD.id; END IF;
    DELETE FROM public.cbt_exams_raw WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;


ALTER FUNCTION "public"."handle_cbt_exams_modification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  account_type text := COALESCE(NEW.raw_app_meta_data OPERATOR(pg_catalog.->>) 'account_type', '');
BEGIN
  IF COALESCE(NEW.raw_app_meta_data OPERATOR(pg_catalog.->>) 'provisioned_by', '')
       OPERATOR(pg_catalog.<>) 'admin' THEN
    -- Public sign-up is disabled, but fail closed if it is ever enabled by
    -- mistake: the Auth identity receives no profile, roster row, or access.
    RETURN NEW;
  END IF;

  IF account_type NOT IN ('student', 'admin') THEN
    RAISE EXCEPTION 'A valid server-owned account type is required';
  END IF;

  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name', pg_catalog.split_part(NEW.email, '@', 1)),
    account_type
  )
  ON CONFLICT (id) DO NOTHING;

  IF account_type OPERATOR(pg_catalog.=) 'student' THEN
    IF COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class', '') OPERATOR(pg_catalog.=) ''
       OR COALESCE(NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section', '') OPERATOR(pg_catalog.=) '' THEN
      RAISE EXCEPTION 'Student provisioning metadata is incomplete';
    END IF;

    INSERT INTO public.students (id, student_id, name, class, section)
    VALUES (
      NEW.id,
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'student_id',
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'name',
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'class',
      NEW.raw_user_meta_data OPERATOR(pg_catalog.->>) 'section'
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin_aal2"() RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF (SELECT auth.role()) = 'service_role' THEN RETURN true; END IF;
  IF (SELECT auth.role()) IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN RETURN false; END IF;
  RETURN public.is_root_developer() OR EXISTS (
    SELECT 1 FROM public.managed_administrators a
    JOIN public.profiles p ON p.id = a.user_id
    WHERE a.user_id = auth.uid() AND a.enabled AND p.role = 'admin'
  );
END;
$$;


ALTER FUNCTION "public"."is_admin_aal2"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_exam_asset_referenced"("asset_name" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
  SELECT CASE
    WHEN NOT public.is_admin_aal2() THEN false
    WHEN asset_name IS NULL
      OR pg_catalog.length(pg_catalog.btrim(asset_name)) OPERATOR(pg_catalog.=) 0
      OR pg_catalog.octet_length(asset_name) OPERATOR(pg_catalog.>) 1024
    THEN false
    ELSE
      EXISTS (
        SELECT 1
        FROM public.cbt_exams_raw AS exam
        WHERE pg_catalog.jsonb_path_exists(
          exam.questions_data,
          '$.** ? (@ == $asset)',
          pg_catalog.jsonb_build_object('asset', asset_name)
        )
      )
      OR EXISTS (
        SELECT 1
        FROM public.question_bank AS question
        WHERE question.question_image_url OPERATOR(pg_catalog.=) asset_name
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements_text(
              CASE
                WHEN pg_catalog.jsonb_typeof(question.option_image_urls)
                  OPERATOR(pg_catalog.=) 'array'
                THEN question.option_image_urls
                ELSE '[]'::pg_catalog.jsonb
              END
            ) AS option_image(value)
            WHERE option_image.value OPERATOR(pg_catalog.=) asset_name
          )
      )
  END;
$_$;


ALTER FUNCTION "public"."is_exam_asset_referenced"("asset_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_root_developer"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.application_owner o
    JOIN public.profiles p ON p.id = o.user_id
    WHERE o.user_id = auth.uid() AND p.role = 'admin');
$$;


ALTER FUNCTION "public"."is_root_developer"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_exam_template_sections"("sections_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  section jsonb;
  subject_row public.subjects%ROWTYPE;
  question_count integer;
  seen text[] := ARRAY[]::text[];
  normalized jsonb := '[]'::jsonb;
  total integer := 0;
BEGIN
  IF sections_param IS NULL OR jsonb_typeof(sections_param) <> 'array' THEN
    RAISE EXCEPTION 'A pattern needs a list of subject sections';
  END IF;
  IF jsonb_array_length(sections_param) = 0 THEN
    RAISE EXCEPTION 'Add at least one subject section to the pattern';
  END IF;
  IF jsonb_array_length(sections_param) > 20 THEN
    RAISE EXCEPTION 'A pattern can have at most 20 subject sections';
  END IF;

  FOR section IN SELECT value FROM jsonb_array_elements(sections_param) LOOP
    IF jsonb_typeof(section) <> 'object' THEN
      RAISE EXCEPTION 'Each pattern section must name a subject and a question count';
    END IF;
    SELECT * INTO subject_row FROM public.subjects AS s
    WHERE lower(s.name) = lower(btrim(COALESCE(section->>'subject', '')));
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Unknown subject "%" in pattern', COALESCE(section->>'subject', '');
    END IF;
    IF NOT subject_row.is_active THEN
      RAISE EXCEPTION 'Subject "%" is inactive. Reactivate it or remove it from the pattern.', subject_row.name;
    END IF;
    IF lower(subject_row.name) = ANY(seen) THEN
      RAISE EXCEPTION 'Subject "%" appears more than once in the pattern', subject_row.name;
    END IF;
    seen := array_append(seen, lower(subject_row.name));

    IF COALESCE(section->>'questionCount', '') !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Question count for "%" must be a whole number', subject_row.name;
    END IF;
    question_count := (section->>'questionCount')::integer;
    IF question_count NOT BETWEEN 1 AND 500 THEN
      RAISE EXCEPTION 'Question count for "%" must be between 1 and 500', subject_row.name;
    END IF;
    total := total + question_count;
    normalized := normalized || jsonb_build_array(
      jsonb_build_object('subject', subject_row.name, 'questionCount', question_count)
    );
  END LOOP;

  IF total > 500 THEN
    RAISE EXCEPTION 'A pattern can contain at most 500 questions in total (this one has %)', total;
  END IF;
  RETURN normalized;
END;
$_$;


ALTER FUNCTION "public"."normalize_exam_template_sections"("sections_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_submission_response_map"("raw_responses" "jsonb", "paper_questions" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
DECLARE
  valid_questions jsonb := '{}'::jsonb;
  response_map jsonb := '{}'::jsonb;
  subject_name text;
  question_item jsonb;
  response_item jsonb;
  selected_value jsonb;
  selected_text text;
  status_value text;
  question_type text;
  question_id text;
  question_count integer := 0;
  option_index integer;
BEGIN
  raw_responses := COALESCE(raw_responses, '[]'::jsonb);
  IF jsonb_typeof(raw_responses) <> 'array' THEN
    RAISE EXCEPTION 'Invalid response payload: expected an array';
  END IF;
  IF octet_length(raw_responses::text) > 262144 THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  IF paper_questions IS NULL OR jsonb_typeof(paper_questions) <> 'object' THEN
    RAISE EXCEPTION 'Invalid server exam paper';
  END IF;

  FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
    IF jsonb_typeof(paper_questions->subject_name) <> 'array' THEN
      RAISE EXCEPTION 'Invalid server question list for subject %', subject_name;
    END IF;
    FOR question_item IN SELECT value FROM jsonb_array_elements(paper_questions->subject_name) LOOP
      question_id := question_item->>'id';
      IF question_id IS NULL OR question_id = '' OR valid_questions ? question_id THEN
        RAISE EXCEPTION 'Invalid or duplicate question ID in server paper';
      END IF;
      valid_questions := jsonb_set(valid_questions, ARRAY[question_id], question_item, true);
      question_count := question_count + 1;
    END LOOP;
  END LOOP;

  IF jsonb_array_length(raw_responses) > question_count THEN
    RAISE EXCEPTION 'Response count exceeds exam question count';
  END IF;

  FOR response_item IN SELECT value FROM jsonb_array_elements(raw_responses) LOOP
    IF jsonb_typeof(response_item) <> 'object' THEN
      RAISE EXCEPTION 'Invalid response entry';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(response_item) AS response_key(key_name)
      WHERE key_name NOT IN ('question_id', 'selected_option', 'status')
    ) THEN
      RAISE EXCEPTION 'Unexpected response field';
    END IF;

    question_id := response_item->>'question_id';
    IF question_id IS NULL OR question_id = '' OR NOT (valid_questions ? question_id) THEN
      RAISE EXCEPTION 'Unknown question ID';
    END IF;
    IF response_map ? question_id THEN
      RAISE EXCEPTION 'Duplicate question ID in response payload';
    END IF;

    status_value := COALESCE(response_item->>'status', 'NOT_VISITED');
    IF status_value NOT IN ('NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED') THEN
      RAISE EXCEPTION 'Invalid response status';
    END IF;

    selected_value := response_item->'selected_option';
    IF selected_value IS NULL OR jsonb_typeof(selected_value) = 'null' THEN
      selected_value := 'null'::jsonb;
      selected_text := NULL;
    ELSIF jsonb_typeof(selected_value) NOT IN ('string', 'number') THEN
      RAISE EXCEPTION 'Invalid selected option type';
    ELSE
      selected_text := selected_value #>> '{}';
    END IF;

    IF status_value IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NULL THEN
      RAISE EXCEPTION 'Answered response has no selected option';
    END IF;
    IF status_value NOT IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NOT NULL THEN
      RAISE EXCEPTION 'Unanswered response contains a selected option';
    END IF;

    question_item := valid_questions->question_id;
    IF selected_text IS NOT NULL THEN
      question_type := upper(COALESCE(question_item->>'type', 'MCQ'));
      IF question_type IN ('NUMERICAL', 'NAT') THEN
        IF length(selected_text) > 64
           OR selected_text !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
          RAISE EXCEPTION 'Invalid numerical response';
        END IF;
      ELSE
        IF selected_text !~ '^[0-9]+$' THEN
          RAISE EXCEPTION 'Invalid MCQ option';
        END IF;
        option_index := selected_text::integer;
        IF jsonb_typeof(question_item->'options') <> 'array'
           OR option_index < 0
           OR option_index >= jsonb_array_length(question_item->'options') THEN
          RAISE EXCEPTION 'MCQ option is out of range';
        END IF;
      END IF;
    END IF;

    response_map := jsonb_set(response_map, ARRAY[question_id], jsonb_build_object(
      'question_id', question_id,
      'selected_option', selected_value,
      'status', status_value
    ), true);
  END LOOP;

  RETURN response_map;
END;
$_$;


ALTER FUNCTION "public"."normalize_submission_response_map"("raw_responses" "jsonb", "paper_questions" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."preflight_validate_exam"("exam_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  private_answers jsonb;
  reconstructed_data jsonb;
  errors text[] := ARRAY[]::text[];
  warnings text[] := ARRAY[]::text[];
  seen_question_ids text[] := ARRAY[]::text[];
  declared_subjects text[] := ARRAY[]::text[];
  subject_name text;
  question_item jsonb;
  question_id text;
  question_image text;
  option_image text;
  answer_item jsonb;
  answer_question_id text;
  total_questions integer := 0;
  verified_assets integer := 0;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  SELECT * INTO exam_row FROM public.cbt_exams_raw WHERE id = exam_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exam not found'; END IF;

  IF exam_row.class IS NULL OR length(btrim(exam_row.class)) = 0 THEN
    errors := array_append(errors, 'Target class is required');
  ELSIF exam_row.class <> 'All'
    AND NOT EXISTS (SELECT 1 FROM public.classes WHERE name = exam_row.class) THEN
    errors := array_append(errors, format('Target class "%s" does not exist', exam_row.class));
  END IF;
  IF exam_row.section IS NULL OR length(btrim(exam_row.section)) = 0 THEN
    errors := array_append(errors, 'Target section is required');
  ELSIF exam_row.class <> 'All' AND exam_row.section <> 'All'
    AND NOT EXISTS (
      SELECT 1 FROM public.classes
      WHERE name = exam_row.class AND exam_row.section = ANY(sections)
    ) THEN
    errors := array_append(errors, format('Target section "%s" is not registered under class "%s"', exam_row.section, exam_row.class));
  END IF;

  SELECT answers INTO private_answers FROM public.cbt_exam_answers WHERE exam_id = exam_id_param;
  IF private_answers IS NULL OR jsonb_typeof(private_answers) <> 'object' THEN
    errors := array_append(errors, 'Private answer key is missing or invalid');
    private_answers := '{}'::jsonb;
  END IF;

  reconstructed_data := public.reconstruct_exam_questions(exam_row.questions_data, private_answers);
  BEGIN
    PERFORM public.validate_full_exam_paper(exam_row.title, reconstructed_data);
  EXCEPTION WHEN OTHERS THEN
    errors := array_append(errors, SQLERRM);
  END;

  IF jsonb_typeof(exam_row.questions_data->'subjects') = 'array' THEN
    FOR subject_name IN SELECT jsonb_array_elements_text(exam_row.questions_data->'subjects') LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.subjects AS configured
        WHERE lower(configured.name) = lower(btrim(subject_name))
      ) THEN
        errors := array_append(errors, format('Unknown subject "%s". Add it under Subjects & Patterns first.', subject_name));
      END IF;
      IF lower(btrim(subject_name)) = ANY(declared_subjects) THEN
        errors := array_append(errors, format('Duplicate subject "%s"', subject_name));
      ELSE
        declared_subjects := array_append(declared_subjects, lower(btrim(subject_name)));
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(exam_row.questions_data->'questions') = 'object' THEN
    FOR subject_name IN SELECT jsonb_object_keys(exam_row.questions_data->'questions') LOOP
      IF NOT (lower(btrim(subject_name)) = ANY(declared_subjects)) THEN
        errors := array_append(errors, format('Questions contain undeclared subject "%s"', subject_name));
      END IF;
      IF jsonb_typeof(exam_row.questions_data->'questions'->subject_name) <> 'array' THEN
        errors := array_append(errors, format('Questions for subject "%s" must be an array', subject_name));
        CONTINUE;
      END IF;

      FOR question_item IN SELECT value FROM jsonb_array_elements(exam_row.questions_data->'questions'->subject_name) LOOP
        total_questions := total_questions + 1;
        question_id := btrim(COALESCE(question_item->>'id', ''));
        IF question_id = '' THEN
          errors := array_append(errors, format('Question %s in %s has no stable ID', total_questions, subject_name));
        ELSIF question_id = ANY(seen_question_ids) THEN
          errors := array_append(errors, format('Duplicate question ID "%s"', question_id));
        ELSE
          seen_question_ids := array_append(seen_question_ids, question_id);
        END IF;

        IF question_item ? 'correctAnswer' OR question_item ? 'correct_answer' THEN
          errors := array_append(errors, format('Question "%s" exposes its answer in public exam data', COALESCE(NULLIF(question_id, ''), total_questions::text)));
        END IF;

        answer_item := private_answers->question_id;
        IF question_id <> '' AND answer_item IS NULL THEN
          errors := array_append(errors, format('Question "%s" has no private answer-key entry', question_id));
        ELSIF answer_item IS NOT NULL AND (
          answer_item->>'subject' IS DISTINCT FROM subject_name
          OR upper(COALESCE(answer_item->>'type', '')) IS DISTINCT FROM upper(COALESCE(question_item->>'type', 'MCQ'))
        ) THEN
          errors := array_append(errors, format('Question "%s" answer metadata does not match the public paper', question_id));
        END IF;

        question_image := btrim(COALESCE(question_item->>'questionImageUrl', question_item->>'imageUrl', ''));
        IF question_image <> '' THEN
          IF question_image ~* '^https?://' OR question_image ~* '^data:' THEN
            errors := array_append(errors, format('Question "%s" must use a private exam-assets path, not an external or embedded image', question_id));
          ELSIF NOT EXISTS (
            SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = question_image
          ) THEN
            errors := array_append(errors, format('Question "%s" references missing storage asset: "%s"', question_id, question_image));
          ELSE
            verified_assets := verified_assets + 1;
          END IF;
        END IF;

        IF jsonb_typeof(question_item->'optionImageUrls') = 'array' THEN
          FOR option_index IN 0..jsonb_array_length(question_item->'optionImageUrls') - 1 LOOP
            option_image := btrim(COALESCE(question_item->'optionImageUrls'->>option_index, ''));
            IF option_image = '' OR lower(option_image) = 'null' THEN CONTINUE; END IF;
            IF option_image ~* '^https?://' OR option_image ~* '^data:' THEN
              errors := array_append(errors, format('Question "%s" option %s must use a private exam-assets path', question_id, option_index + 1));
            ELSIF NOT EXISTS (
              SELECT 1 FROM storage.objects WHERE bucket_id = 'exam-assets' AND name = option_image
            ) THEN
              errors := array_append(errors, format('Question "%s" option %s references missing storage asset: "%s"', question_id, option_index + 1, option_image));
            ELSE
              verified_assets := verified_assets + 1;
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  FOR answer_question_id IN SELECT jsonb_object_keys(private_answers) LOOP
    IF NOT (answer_question_id = ANY(seen_question_ids)) THEN
      errors := array_append(errors, format('Private answer key contains unknown question ID "%s"', answer_question_id));
    END IF;
  END LOOP;

  IF total_questions = 0 THEN errors := array_append(errors, 'The exam paper has zero questions'); END IF;

  RETURN jsonb_build_object(
    'valid', cardinality(errors) = 0,
    'errors', to_jsonb(errors),
    'warnings', to_jsonb(warnings),
    'totalQuestions', total_questions,
    'verifiedAssets', verified_assets
  );
END;
$$;


ALTER FUNCTION "public"."preflight_validate_exam"("exam_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_class_deletion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."protect_class_deletion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_committed_student_results"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_setting('cbt.trusted_result_retention', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Committed examination results are immutable and cannot be updated or deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_committed_student_results"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_exam_deletion"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."protect_exam_deletion"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."protect_inactive_student_assignment"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND (
    NEW.class IS DISTINCT FROM OLD.class OR NEW.section IS DISTINCT FROM OLD.section
  ) THEN
    RAISE EXCEPTION 'Inactive student assignments cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."protect_inactive_student_assignment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconstruct_exam_questions"("qdata" "jsonb", "ans" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  subject_name text;
  question_obj jsonb;
  reconstructed_subject jsonb;
  reconstructed_questions jsonb := '{}'::jsonb;
  answer_info jsonb;
BEGIN
  IF qdata IS NULL OR jsonb_typeof(qdata->'questions') <> 'object' OR ans IS NULL THEN
    RETURN qdata;
  END IF;
  FOR subject_name IN SELECT jsonb_object_keys(qdata->'questions') LOOP
    reconstructed_subject := '[]'::jsonb;
    FOR question_obj IN SELECT value FROM jsonb_array_elements(qdata->'questions'->subject_name) LOOP
      answer_info := ans->(question_obj->>'id');
      IF answer_info IS NOT NULL THEN
        question_obj := jsonb_set(question_obj, '{correctAnswer}', answer_info->'correct_answer', true);
      END IF;
      reconstructed_subject := reconstructed_subject || jsonb_build_array(question_obj);
    END LOOP;
    reconstructed_questions := jsonb_set(reconstructed_questions, ARRAY[subject_name], reconstructed_subject, true);
  END LOOP;
  RETURN jsonb_set(qdata, '{questions}', reconstructed_questions, true);
END;
$$;


ALTER FUNCTION "public"."reconstruct_exam_questions"("qdata" "jsonb", "ans" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_exam_asset_cleanup"("asset_names" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  normalized_names pg_catalog.text[];
  asset_name pg_catalog.text;
  supplied_count pg_catalog.int4;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;

  supplied_count := COALESCE(pg_catalog.cardinality(asset_names), 0);
  IF supplied_count NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Cleanup audit requires between 1 and 100 asset paths';
  END IF;

  SELECT pg_catalog.array_agg(
    DISTINCT pg_catalog.btrim(supplied.value)
    ORDER BY pg_catalog.btrim(supplied.value)
  )
  INTO normalized_names
  FROM pg_catalog.unnest(asset_names) AS supplied(value)
  WHERE supplied.value IS NOT NULL
    AND pg_catalog.octet_length(pg_catalog.btrim(supplied.value)) BETWEEN 1 AND 1024;

  IF COALESCE(pg_catalog.cardinality(normalized_names), 0)
    OPERATOR(pg_catalog.<>) supplied_count
  THEN
    RAISE EXCEPTION 'Asset paths must be unique, non-empty, and no more than 1024 bytes';
  END IF;

  FOREACH asset_name IN ARRAY normalized_names LOOP
    IF public.is_exam_asset_referenced(asset_name) THEN
      RAISE EXCEPTION 'Asset "%" is now referenced and cannot be recorded as deleted', asset_name;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM storage.objects AS o
      WHERE o.bucket_id OPERATOR(pg_catalog.=) 'exam-assets'
        AND o.name OPERATOR(pg_catalog.=) asset_name
    ) THEN
      RAISE EXCEPTION 'Asset "%" still exists in storage and was not deleted', asset_name;
    END IF;
  END LOOP;

  INSERT INTO public.admin_audit_events (
    actor_user_id,
    action,
    target_type,
    target_id,
    metadata
  ) VALUES (
    auth.uid(),
    'CLEANUP_UNREFERENCED_ASSETS',
    'STORAGE',
    'exam-assets',
    pg_catalog.jsonb_build_object(
      'deleted_count', pg_catalog.cardinality(normalized_names),
      'deleted_paths', pg_catalog.to_jsonb(normalized_names)
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'deleted_count', pg_catalog.cardinality(normalized_names),
    'deleted_paths', pg_catalog.to_jsonb(normalized_names)
  );
END;
$$;


ALTER FUNCTION "public"."record_exam_asset_cleanup"("asset_names" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_result_export"("exam_id_param" "uuid", "export_format_param" "text", "expected_result_count_param" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  normalized_format text := upper(btrim(COALESCE(export_format_param, '')));
  authoritative_count integer;
  exam_title text;
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access with MFA (AAL2) is required';
  END IF;
  IF exam_id_param IS NULL THEN
    RAISE EXCEPTION 'Exam ID is required';
  END IF;
  IF normalized_format NOT IN ('CSV', 'PDF') THEN
    RAISE EXCEPTION 'Export format must be CSV or PDF';
  END IF;
  IF expected_result_count_param IS NULL OR expected_result_count_param < 1 OR expected_result_count_param > 20000 THEN
    RAISE EXCEPTION 'Expected result count must be between 1 and 20000';
  END IF;

  SELECT title INTO exam_title
  FROM public.cbt_exams_raw
  WHERE id = exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Exam was not found';
  END IF;

  SELECT count(*)::integer INTO authoritative_count
  FROM public.student_results
  WHERE exam_id = exam_id_param::text;

  IF authoritative_count IS DISTINCT FROM expected_result_count_param THEN
    RAISE EXCEPTION 'Result set changed: expected %, found %. Refresh results before exporting.',
      expected_result_count_param, authoritative_count;
  END IF;

  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'RESULT_EXPORT_REQUESTED',
    'cbt_exam',
    exam_id_param::text,
    jsonb_build_object(
      'format', normalized_format,
      'result_count', authoritative_count,
      'exam_title', exam_title
    )
  );

  RETURN jsonb_build_object(
    'authorized', true,
    'format', normalized_format,
    'result_count', authoritative_count
  );
END;
$$;


ALTER FUNCTION "public"."record_result_export"("exam_id_param" "uuid", "export_format_param" "text", "expected_result_count_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_managed_administrator"("account_id_param" "uuid", "creator_id_param" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Trusted provisioning required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.application_owner WHERE user_id = creator_id_param)
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = account_id_param AND role = 'admin')
    OR account_id_param = creator_id_param THEN
    RAISE EXCEPTION 'Invalid administrator creator or account';
  END IF;
  INSERT INTO public.managed_administrators(user_id, created_by) VALUES (account_id_param, creator_id_param);
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (creator_id_param, 'CREATE_ADMINISTRATOR', 'profile', account_id_param::text, '{}'::jsonb);
END;
$$;


ALTER FUNCTION "public"."register_managed_administrator"("account_id_param" "uuid", "creator_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_student_session"() RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  released_count pg_catalog.int4;
  caller_session_id pg_catalog.uuid;
BEGIN
  caller_session_id := public.current_auth_session_id();
  IF auth.uid() IS NULL OR caller_session_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.students AS s
  SET active_auth_session_id = NULL
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.active_auth_session_id OPERATOR(pg_catalog.=) caller_session_id;

  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count OPERATOR(pg_catalog.=) 1;
END;
$$;


ALTER FUNCTION "public"."release_student_session"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_active_subject"("subject_name_param" "text") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT s.name FROM public.subjects AS s
  WHERE lower(s.name) = lower(btrim(COALESCE(subject_name_param, ''))) AND s.is_active;
$$;


ALTER FUNCTION "public"."resolve_active_subject"("subject_name_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_application_reset_preview"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  counts jsonb;
  legacy_attempts bigint := 0;
  legacy_exams bigint := 0;
  legacy_questions bigint := 0;
  legacy_proctor_flags bigint := 0;
  legacy_live_feeds bigint := 0;
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;

  IF pg_catalog.to_regclass('public.attempts') IS NOT NULL THEN
    legacy_attempts := public.root_count_optional_legacy_table('attempts');
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    legacy_exams := public.root_count_optional_legacy_table('exams');
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    legacy_questions := public.root_count_optional_legacy_table('questions');
  END IF;
  IF pg_catalog.to_regclass('public.proctor_flags') IS NOT NULL THEN
    legacy_proctor_flags := public.root_count_optional_legacy_table('proctor_flags');
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    legacy_live_feeds := public.root_count_optional_legacy_table('live_feeds');
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'student_accounts', (
      SELECT pg_catalog.count(*)
      FROM public.profiles AS p
      WHERE p.role IS DISTINCT FROM 'admin'
        AND NOT EXISTS (SELECT 1 FROM public.application_owner AS owner WHERE owner.user_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM public.managed_administrators AS managed WHERE managed.user_id = p.id)
    ),
    'students', (SELECT pg_catalog.count(*) FROM public.students),
    'classes', (SELECT pg_catalog.count(*) FROM public.classes),
    'exams', (SELECT pg_catalog.count(*) FROM public.cbt_exams_raw),
    'active_sessions', (SELECT pg_catalog.count(*) FROM public.active_sessions),
    'results', (SELECT pg_catalog.count(*) FROM public.student_results),
    'questions', (SELECT pg_catalog.count(*) FROM public.question_bank),
    'import_history', (SELECT pg_catalog.count(*) FROM public.import_history),
    'import_batches', (SELECT pg_catalog.count(*) FROM public.question_import_batches),
    'audit_events', (SELECT pg_catalog.count(*) FROM public.admin_audit_events),
    'legacy_attempts', legacy_attempts,
    'legacy_exams', legacy_exams,
    'legacy_questions', legacy_questions,
    'legacy_proctor_flags', legacy_proctor_flags,
    'legacy_live_feeds', legacy_live_feeds
  ) INTO counts;

  RETURN counts;
END;
$$;


ALTER FUNCTION "public"."root_application_reset_preview"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_application_reset_preview_for_actor"("actor_id_param" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner
    WHERE owner.user_id = actor_id_param
  ) THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  RETURN public.root_application_reset_preview();
END;
$$;


ALTER FUNCTION "public"."root_application_reset_preview_for_actor"("actor_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_clear_exams"("confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  deleted_count bigint;
  result_count bigint;
  session_count bigint;
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR EXAMS' THEN RAISE EXCEPTION 'Exact exams confirmation is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(2026092211);
  SELECT count(*) INTO result_count FROM public.student_results;
  SELECT count(*) INTO session_count FROM public.active_sessions;
  IF result_count > 0 OR session_count > 0 THEN
    RAISE EXCEPTION 'Clear exam results and active student sessions first';
  END IF;
  LOCK TABLE public.cbt_exam_answers, public.cbt_exams_raw, public.exam_status_events IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO deleted_count FROM public.cbt_exams_raw;
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers WHERE true;
  DELETE FROM public.exam_status_events WHERE true;
  DELETE FROM public.cbt_exams_raw WHERE true;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('exams');
  END IF;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_EXAMS', 'cbt_exams', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$$;


ALTER FUNCTION "public"."root_clear_exams"("confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_clear_questions"("confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE deleted_count bigint;
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR QUESTION BANK' THEN RAISE EXCEPTION 'Exact question-bank confirmation is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(2026092211);
  LOCK TABLE public.question_bank IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO deleted_count FROM public.question_bank;
  DELETE FROM public.question_bank WHERE true;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_QUESTION_BANK', 'question_bank', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count, 'asset_disposition', 'retained_for_exam_snapshot_safety'));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$$;


ALTER FUNCTION "public"."root_clear_questions"("confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_clear_results"("confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE deleted_count bigint;
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF confirmation_param IS DISTINCT FROM 'CLEAR EXAM RESULTS' THEN RAISE EXCEPTION 'Exact results confirmation is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(2026092211);
  LOCK TABLE public.student_results IN ACCESS EXCLUSIVE MODE;
  SELECT count(*) INTO deleted_count FROM public.student_results;
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  DELETE FROM public.student_results WHERE true;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'ROOT_CLEAR_EXAM_RESULTS', 'student_results', NULL,
      pg_catalog.jsonb_build_object('deleted_count', deleted_count));
  RETURN pg_catalog.jsonb_build_object('deleted', deleted_count);
END;
$$;


ALTER FUNCTION "public"."root_clear_results"("confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_clear_scoped_data_for_actor"("actor_id_param" "uuid", "target_param" "text", "confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner WHERE owner.user_id = actor_id_param
  ) THEN RAISE EXCEPTION 'Root developer access is required'; END IF;
  IF target_param NOT IN ('student_results', 'cbt_exams', 'question_bank') THEN
    RAISE EXCEPTION 'Unsupported scoped cleanup target';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  IF target_param = 'student_results' THEN RETURN public.root_clear_results(confirmation_param); END IF;
  IF target_param = 'cbt_exams' THEN RETURN public.root_clear_exams(confirmation_param); END IF;
  RETURN public.root_clear_questions(confirmation_param);
END;
$$;


ALTER FUNCTION "public"."root_clear_scoped_data_for_actor"("actor_id_param" "uuid", "target_param" "text", "confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_count_optional_legacy_table"("table_name_param" "text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  row_count bigint;
BEGIN
  IF table_name_param NOT IN ('attempts', 'exams', 'questions', 'proctor_flags', 'live_feeds') THEN
    RAISE EXCEPTION 'Unsupported legacy table';
  END IF;
  EXECUTE pg_catalog.format('SELECT count(*) FROM %I.%I', 'public', table_name_param) INTO row_count;
  RETURN row_count;
END;
$$;


ALTER FUNCTION "public"."root_count_optional_legacy_table"("table_name_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_delete_optional_legacy_table"("table_name_param" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF table_name_param NOT IN ('attempts', 'exams', 'questions', 'proctor_flags', 'live_feeds') THEN
    RAISE EXCEPTION 'Unsupported legacy table';
  END IF;
  EXECUTE pg_catalog.format('DELETE FROM %I.%I WHERE true', 'public', table_name_param);
END;
$$;


ALTER FUNCTION "public"."root_delete_optional_legacy_table"("table_name_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_reset_application_data"("confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  actor_id uuid := auth.uid();
  counts jsonb;
  student_user_ids uuid[];
BEGIN
  IF NOT public.is_root_developer() THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  IF confirmation_param IS DISTINCT FROM 'RESET APPLICATION DATA' THEN
    RAISE EXCEPTION 'Exact reset confirmation is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(2026092205);
  counts := public.root_application_reset_preview();

  SELECT pg_catalog.array_agg(p.id ORDER BY p.id)
  INTO student_user_ids
  FROM public.profiles AS p
  WHERE p.role IS DISTINCT FROM 'admin'
    AND NOT EXISTS (SELECT 1 FROM public.application_owner AS owner WHERE owner.user_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.managed_administrators AS managed WHERE managed.user_id = p.id);

  LOCK TABLE
    public.active_sessions,
    public.student_results,
    public.cbt_exam_answers,
    public.cbt_exams_raw,
    public.exam_status_events,
    public.question_import_batches,
    public.import_history,
    public.question_bank,
    public.students,
    public.classes,
    public.admin_audit_events
  IN ACCESS EXCLUSIVE MODE;

  IF pg_catalog.to_regclass('public.proctor_flags') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('proctor_flags');
  END IF;
  IF pg_catalog.to_regclass('public.attempts') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('attempts');
  END IF;
  IF pg_catalog.to_regclass('public.questions') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('questions');
  END IF;
  IF pg_catalog.to_regclass('public.exams') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('exams');
  END IF;
  IF pg_catalog.to_regclass('public.live_feeds') IS NOT NULL THEN
    PERFORM public.root_delete_optional_legacy_table('live_feeds');
  END IF;

  DELETE FROM public.active_sessions WHERE true;
  PERFORM pg_catalog.set_config('cbt.trusted_result_retention', 'on', true);
  DELETE FROM public.student_results WHERE true;
  PERFORM pg_catalog.set_config('cbt.trusted_exam_context', 'on', true);
  DELETE FROM public.cbt_exam_answers WHERE true;
  DELETE FROM public.cbt_exams_raw WHERE true;
  DELETE FROM public.exam_status_events WHERE true;
  DELETE FROM public.question_import_batches WHERE true;
  DELETE FROM public.import_history WHERE true;
  DELETE FROM public.question_bank WHERE true;
  DELETE FROM public.students WHERE true;
  DELETE FROM public.classes WHERE true;
  DELETE FROM public.admin_audit_events WHERE true;

  INSERT INTO public.admin_audit_events (
    actor_user_id, action, target_type, target_id, metadata
  ) VALUES (
    actor_id,
    'RESET_APPLICATION_DATA',
    'application',
    NULL,
    pg_catalog.jsonb_build_object('deleted', counts, 'preserved', 'root_and_administrator_accounts')
  );

  RETURN pg_catalog.jsonb_build_object(
    'deleted', counts,
    'auth_user_ids', pg_catalog.to_jsonb(COALESCE(student_user_ids, ARRAY[]::uuid[]))
  );
END;
$$;


ALTER FUNCTION "public"."root_reset_application_data"("confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."root_reset_application_data_for_actor"("actor_id_param" "uuid", "confirmation_param" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF actor_id_param IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.application_owner AS owner
    WHERE owner.user_id = actor_id_param
  ) THEN
    RAISE EXCEPTION 'Root developer access is required';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', actor_id_param::text, true);
  RETURN public.root_reset_application_data(confirmation_param);
END;
$$;


ALTER FUNCTION "public"."root_reset_application_data_for_actor"("actor_id_param" "uuid", "confirmation_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."run_scheduled_session_finalization"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  RETURN public.finalize_expired_sessions_internal(
    200,
    120,
    '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid,
    'scheduler'
  );
END;
$$;


ALTER FUNCTION "public"."run_scheduled_session_finalization"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sanitize_exam_responses"("raw_responses" "jsonb", "paper_questions" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
DECLARE
  subject_name text;
  raw_subject jsonb;
  cleaned_subject jsonb;
  cleaned jsonb := '{}'::jsonb;
  response_item jsonb;
  question_item jsonb;
  selected_value jsonb;
  selected_text text;
  status_value text;
  question_type text;
  paper_length integer;
  raw_length integer;
  option_index integer;
BEGIN
  raw_responses := COALESCE(raw_responses, '{}'::jsonb);
  IF jsonb_typeof(raw_responses) <> 'object' THEN
    RAISE EXCEPTION 'Invalid progress payload: expected an object';
  END IF;
  IF octet_length(raw_responses::text) > 262144 THEN
    RAISE EXCEPTION 'Progress payload exceeds 256 KiB';
  END IF;
  IF paper_questions IS NULL OR jsonb_typeof(paper_questions) <> 'object' THEN
    RAISE EXCEPTION 'Invalid server exam paper';
  END IF;

  FOR subject_name IN SELECT jsonb_object_keys(raw_responses) LOOP
    IF NOT (paper_questions ? subject_name) THEN
      RAISE EXCEPTION 'Unknown response subject: %', subject_name;
    END IF;
  END LOOP;

  FOR subject_name IN SELECT jsonb_object_keys(paper_questions) LOOP
    IF jsonb_typeof(paper_questions->subject_name) <> 'array' THEN
      RAISE EXCEPTION 'Invalid server question list for subject %', subject_name;
    END IF;
    paper_length := jsonb_array_length(paper_questions->subject_name);
    raw_subject := raw_responses->subject_name;
    IF raw_subject IS NULL THEN
      raw_subject := '[]'::jsonb;
    ELSIF jsonb_typeof(raw_subject) <> 'array' THEN
      RAISE EXCEPTION 'Invalid response list for subject %', subject_name;
    END IF;
    raw_length := jsonb_array_length(raw_subject);
    IF raw_length > paper_length THEN
      RAISE EXCEPTION 'Too many responses for subject %', subject_name;
    END IF;

    cleaned_subject := '[]'::jsonb;
    IF paper_length > 0 THEN
      FOR idx IN 0..paper_length - 1 LOOP
        question_item := paper_questions->subject_name->idx;
        response_item := CASE WHEN idx < raw_length THEN raw_subject->idx ELSE NULL END;

        IF response_item IS NULL OR jsonb_typeof(response_item) = 'null' THEN
          response_item := jsonb_build_object('selectedOption', NULL, 'status', 'NOT_VISITED');
        ELSIF jsonb_typeof(response_item) <> 'object' THEN
          RAISE EXCEPTION 'Invalid response at %.%', subject_name, idx;
        END IF;

        IF EXISTS (
          SELECT 1 FROM jsonb_object_keys(response_item) AS response_key(key_name)
          WHERE key_name NOT IN ('selectedOption', 'status')
        ) THEN
          RAISE EXCEPTION 'Unexpected response field at %.%', subject_name, idx;
        END IF;

        status_value := COALESCE(response_item->>'status', 'NOT_VISITED');
        IF status_value NOT IN ('NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED') THEN
          RAISE EXCEPTION 'Invalid response status at %.%', subject_name, idx;
        END IF;

        selected_value := response_item->'selectedOption';
        IF selected_value IS NULL OR jsonb_typeof(selected_value) = 'null' THEN
          selected_value := 'null'::jsonb;
          selected_text := NULL;
        ELSIF jsonb_typeof(selected_value) NOT IN ('string', 'number') THEN
          RAISE EXCEPTION 'Invalid selected option type at %.%', subject_name, idx;
        ELSE
          selected_text := selected_value #>> '{}';
        END IF;

        IF status_value IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NULL THEN
          RAISE EXCEPTION 'Answered response has no selected option at %.%', subject_name, idx;
        END IF;
        IF status_value NOT IN ('ANSWERED', 'ANSWERED_MARKED') AND selected_text IS NOT NULL THEN
          RAISE EXCEPTION 'Unanswered response contains a selected option at %.%', subject_name, idx;
        END IF;

        IF selected_text IS NOT NULL THEN
          question_type := upper(COALESCE(question_item->>'type', 'MCQ'));
          IF question_type IN ('NUMERICAL', 'NAT') THEN
            IF length(selected_text) > 64
               OR selected_text !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
              RAISE EXCEPTION 'Invalid numerical response at %.%', subject_name, idx;
            END IF;
          ELSE
            IF selected_text !~ '^[0-9]+$' THEN
              RAISE EXCEPTION 'Invalid MCQ option at %.%', subject_name, idx;
            END IF;
            option_index := selected_text::integer;
            IF jsonb_typeof(question_item->'options') <> 'array'
               OR option_index < 0
               OR option_index >= jsonb_array_length(question_item->'options') THEN
              RAISE EXCEPTION 'MCQ option is out of range at %.%', subject_name, idx;
            END IF;
          END IF;
        END IF;

        cleaned_subject := cleaned_subject || jsonb_build_array(jsonb_build_object(
          'selectedOption', selected_value,
          'status', status_value
        ));
      END LOOP;
    END IF;
    cleaned := jsonb_set(cleaned, ARRAY[subject_name], cleaned_subject, true);
  END LOOP;

  RETURN cleaned;
END;
$_$;


ALTER FUNCTION "public"."sanitize_exam_responses"("raw_responses" "jsonb", "paper_questions" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_managed_administrator_enabled"("account_id_param" "uuid", "enabled_param" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF NOT public.is_root_developer() THEN RAISE EXCEPTION 'Root developer access required'; END IF;
  IF enabled_param IS NULL THEN RAISE EXCEPTION 'Enabled state is required'; END IF;
  UPDATE public.managed_administrators SET enabled = enabled_param WHERE user_id = account_id_param;
  IF NOT FOUND THEN RAISE EXCEPTION 'Managed administrator not found'; END IF;
  INSERT INTO public.admin_audit_events(actor_user_id, action, target_type, target_id, metadata)
    VALUES (auth.uid(), 'SET_ADMINISTRATOR_ACCESS', 'profile', account_id_param::text,
      pg_catalog.jsonb_build_object('enabled', enabled_param));
END;
$$;


ALTER FUNCTION "public"."set_managed_administrator_enabled"("account_id_param" "uuid", "enabled_param" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_session_response_schema"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
BEGIN
  NEW.response_schema := public.build_session_response_schema(NEW.jumbled_exam_data);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_session_response_schema"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_exam_session"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF exam_data_param IS NOT NULL
    AND pg_catalog.octet_length(exam_data_param::pg_catalog.text) OPERATOR(pg_catalog.>) 8388608
  THEN
    RAISE EXCEPTION 'Exam payload exceeds 8 MiB';
  END IF;
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.start_exam_session_stage3_internal(
    exam_id_param,
    exam_data_param,
    responses_param
  );
END;
$$;


ALTER FUNCTION "public"."start_exam_session"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."start_exam_session"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") IS 'Starts or resumes the authenticated student exam; named arguments are part of the PostgREST API contract.';



CREATE OR REPLACE FUNCTION "public"."start_exam_session_stage3_internal"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  student_row public.students%ROWTYPE;
  exam_row public.cbt_exams_raw%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  duration_seconds pg_catalog.int4;
  remaining_seconds pg_catalog.int4;
  session_id pg_catalog.text;
  subject_name pg_catalog.text;
  shuffled_questions pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  shuffled_subject pg_catalog.jsonb;
  server_exam_data pg_catalog.jsonb;
  initial_responses pg_catalog.jsonb;
  start_time pg_catalog.timestamptz;
  final_result pg_catalog.jsonb;
BEGIN
  -- These legacy parameters remain for PostgREST compatibility. The server-owned paper and initial response state intentionally replace their values.
  PERFORM exam_data_param, responses_param;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;

  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  SELECT e.*
  INTO exam_row
  FROM public.cbt_exams_raw AS e
  WHERE e.id OPERATOR(pg_catalog.=) exam_id_param;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This exam is not available';
  END IF;

  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class OPERATOR(pg_catalog.=) 'All'
    OR exam_row.class OPERATOR(pg_catalog.=) student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section OPERATOR(pg_catalog.=) 'All'
    OR exam_row.section OPERATOR(pg_catalog.=) student_row.section
  ) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.student_results AS r
    WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
      AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text
  ) THEN
    RAISE EXCEPTION 'This exam has already been submitted';
  END IF;

  session_id := student_row.id::pg_catalog.text
    OPERATOR(pg_catalog.||) '_'
    OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_id;

  IF FOUND THEN
    IF exam_row.status NOT IN ('ACTIVE', 'ENDED') OR session_row.started_at IS NULL THEN
      RAISE EXCEPTION 'This exam session is not available';
    END IF;

    IF session_row.deadline_at IS NULL THEN
      duration_seconds := GREATEST(
        COALESCE(((session_row.jumbled_exam_data ->> 'duration')::pg_catalog.int4), 180),
        1
      ) OPERATOR(pg_catalog.*) 60;
      UPDATE public.active_sessions AS s
      SET deadline_at = session_row.started_at + pg_catalog.make_interval(secs => duration_seconds)
      WHERE s.id OPERATOR(pg_catalog.=) session_id
      RETURNING s.* INTO session_row;
    END IF;

    IF pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at THEN
      final_result := public.submit_exam(exam_id_param, '[]'::pg_catalog.jsonb);
      RETURN pg_catalog.jsonb_build_object(
        'expired', true,
        'time_left', 0,
        'result', final_result
      );
    END IF;

    remaining_seconds := GREATEST(
      pg_catalog.ceil(
        EXTRACT(EPOCH FROM (session_row.deadline_at - pg_catalog.clock_timestamp()))
      )::pg_catalog.int4,
      0
    );
    RETURN pg_catalog.jsonb_build_object(
      'time_left', remaining_seconds,
      'started_at', session_row.started_at,
      'deadline_at', session_row.deadline_at,
      'jumbled_exam_data', session_row.jumbled_exam_data,
      'user_responses', session_row.user_responses,
      'version', session_row.version
    );
  END IF;

  IF exam_row.status OPERATOR(pg_catalog.<>) 'ACTIVE' THEN
    RAISE EXCEPTION 'This exam is not available';
  END IF;
  IF pg_catalog.jsonb_typeof(exam_row.questions_data -> 'questions') OPERATOR(pg_catalog.<>) 'object' THEN
    RAISE EXCEPTION 'Exam question data is invalid';
  END IF;

  FOR subject_name IN
    SELECT pg_catalog.jsonb_object_keys(exam_row.questions_data -> 'questions')
  LOOP
    SELECT COALESCE(pg_catalog.jsonb_agg(question ORDER BY pg_catalog.random()), '[]'::pg_catalog.jsonb)
    INTO shuffled_subject
    FROM pg_catalog.jsonb_array_elements(
      exam_row.questions_data -> 'questions' -> subject_name
    ) AS question;
    shuffled_questions := pg_catalog.jsonb_set(
      shuffled_questions,
      ARRAY[subject_name],
      shuffled_subject,
      true
    );
  END LOOP;

  server_exam_data := pg_catalog.jsonb_set(
    exam_row.questions_data,
    '{questions}',
    shuffled_questions,
    true
  );
  initial_responses := public.sanitize_exam_responses(
    '{}'::pg_catalog.jsonb,
    server_exam_data -> 'questions'
  );
  duration_seconds := GREATEST(
    COALESCE(((server_exam_data ->> 'duration')::pg_catalog.int4), 180),
    1
  ) OPERATOR(pg_catalog.*) 60;
  start_time := pg_catalog.clock_timestamp();

  INSERT INTO public.active_sessions (
    id,
    student_id,
    exam_id,
    user_responses,
    jumbled_exam_data,
    time_left,
    started_at,
    deadline_at,
    updated_at,
    version
  ) VALUES (
    session_id,
    student_row.student_id,
    exam_id_param::pg_catalog.text,
    initial_responses,
    server_exam_data,
    duration_seconds,
    start_time,
    start_time + pg_catalog.make_interval(secs => duration_seconds),
    start_time,
    1
  )
  RETURNING * INTO session_row;

  RETURN pg_catalog.jsonb_build_object(
    'time_left', duration_seconds,
    'started_at', session_row.started_at,
    'deadline_at', session_row.deadline_at,
    'jumbled_exam_data', session_row.jumbled_exam_data,
    'user_responses', session_row.user_responses,
    'version', session_row.version
  );
END;
$$;


ALTER FUNCTION "public"."start_exam_session_stage3_internal"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."subject_usage"("subject_name_param" "text") RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  SELECT jsonb_build_object(
    'questions', (SELECT count(*) FROM public.question_bank AS q
                  WHERE lower(q.subject) = lower(subject_name_param)),
    'templates', (SELECT count(*) FROM public.exam_templates AS t
                  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.sections) AS s
                                WHERE lower(s->>'subject') = lower(subject_name_param))),
    'activeTemplates', (SELECT count(*) FROM public.exam_templates AS t
                  WHERE t.is_active AND EXISTS (SELECT 1 FROM jsonb_array_elements(t.sections) AS s
                                WHERE lower(s->>'subject') = lower(subject_name_param))),
    'exams', (SELECT count(*) FROM public.cbt_exams_raw AS e
              WHERE jsonb_typeof(e.questions_data->'subjects') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.questions_data->'subjects') AS x
                            WHERE lower(btrim(x)) = lower(subject_name_param)))
  );
$$;


ALTER FUNCTION "public"."subject_usage"("subject_name_param" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_exam"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  result_row public.student_results%ROWTYPE;
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  BEGIN
    PERFORM public.assert_current_student_session();
  EXCEPTION WHEN OTHERS THEN
    -- A response may be lost after a successful commit. Even if a newer device
    -- has since taken over, return the already committed immutable result.
    -- This branch cannot create, alter, or delete a result or active session.
    SELECT r.*
    INTO result_row
    FROM public.students AS s
    JOIN public.student_results AS r
      ON r.student_id OPERATOR(pg_catalog.=) s.student_id
     AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text
    WHERE s.id OPERATOR(pg_catalog.=) auth.uid();

    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'totalScore', result_row.total_score,
        'maxScore', result_row.max_score,
        'correct', result_row.correct,
        'incorrect', result_row.incorrect,
        'unattempted', result_row.unattempted,
        'subjectScores', result_row.subject_scores
      );
    END IF;
    RAISE;
  END;

  -- The browser confirmed its final answers with a versioned autosave just
  -- before submitting. Grade the stored server snapshot so a stale tab cannot
  -- overwrite newer answers and the admin review matches the grade exactly.
  IF expected_version_param IS NOT NULL THEN
    RETURN public.submit_exam_stage3_internal(exam_id_param, NULL);
  END IF;

  -- Legacy clients (no version) keep the previous contract.
  RETURN public.submit_exam_stage3_internal(exam_id_param, responses_param);
END;
$$;


ALTER FUNCTION "public"."submit_exam"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_exam_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  exam_row public.cbt_exams_raw%ROWTYPE;
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  result_row public.student_results%ROWTYPE;
  answers_obj pg_catalog.jsonb;
  response_map pg_catalog.jsonb;
  server_submission pg_catalog.jsonb;
  answer_entry pg_catalog.record;
  answer_data pg_catalog.jsonb;
  response_data pg_catalog.jsonb;
  marks_correct pg_catalog.numeric;
  marks_incorrect pg_catalog.numeric;
  total_score pg_catalog.numeric := 0;
  correct_count pg_catalog.int4 := 0;
  incorrect_count pg_catalog.int4 := 0;
  unattempted_count pg_catalog.int4 := 0;
  total_questions pg_catalog.int4 := 0;
  subject_scores pg_catalog.jsonb := '{}'::pg_catalog.jsonb;
  subject_name pg_catalog.text;
  is_attempted pg_catalog.bool;
  is_correct pg_catalog.bool;
  user_val pg_catalog.numeric;
  correct_val pg_catalog.numeric;
BEGIN
  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'totalScore', result_row.total_score,
      'maxScore', result_row.max_score,
      'correct', result_row.correct,
      'incorrect', result_row.incorrect,
      'unattempted', result_row.unattempted,
      'subjectScores', result_row.subject_scores
    );
  END IF;

  SELECT e.*
  INTO exam_row
  FROM public.cbt_exams_raw AS e
  WHERE e.id OPERATOR(pg_catalog.=) exam_id_param;
  IF NOT FOUND OR exam_row.status NOT IN ('ACTIVE', 'ENDED') THEN
    RAISE EXCEPTION 'This exam is not available for submission';
  END IF;
  IF NOT (
    exam_row.class IS NULL
    OR exam_row.class OPERATOR(pg_catalog.=) 'All'
    OR exam_row.class OPERATOR(pg_catalog.=) student_row.class
  ) OR NOT (
    exam_row.section IS NULL
    OR exam_row.section OPERATOR(pg_catalog.=) 'All'
    OR exam_row.section OPERATOR(pg_catalog.=) student_row.section
  ) THEN
    RAISE EXCEPTION 'This exam is not assigned to you';
  END IF;

  SELECT s.*
  INTO session_row
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) (
    student_row.id::pg_catalog.text
      OPERATOR(pg_catalog.||) '_'
      OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text
  );
  IF NOT FOUND OR session_row.started_at IS NULL OR session_row.deadline_at IS NULL THEN
    RAISE EXCEPTION 'Exam session was not started correctly';
  END IF;

  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;

  -- At/after the strict deadline, grade only the last server-confirmed snapshot.
  -- The 180-second grace period controls delivery, never answer acceptance.
  IF pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
    OR responses_param IS NULL
    OR (
      pg_catalog.jsonb_typeof(responses_param) OPERATOR(pg_catalog.=) 'array'
      AND pg_catalog.jsonb_array_length(responses_param) OPERATOR(pg_catalog.=) 0
    )
  THEN
    server_submission := public.exam_progress_to_submission(
      session_row.user_responses,
      session_row.jumbled_exam_data -> 'questions'
    );
    response_map := public.normalize_submission_response_map(
      server_submission,
      session_row.jumbled_exam_data -> 'questions'
    );
  ELSE
    response_map := public.normalize_submission_response_map(
      responses_param,
      session_row.jumbled_exam_data -> 'questions'
    );
  END IF;

  SELECT a.answers
  INTO answers_obj
  FROM public.cbt_exam_answers AS a
  WHERE a.exam_id OPERATOR(pg_catalog.=) exam_id_param;
  IF answers_obj IS NULL THEN
    RAISE EXCEPTION 'Answer key not found';
  END IF;

  marks_correct := COALESCE((session_row.jumbled_exam_data ->> 'marksCorrect')::pg_catalog.numeric, 4);
  marks_incorrect := COALESCE((session_row.jumbled_exam_data ->> 'marksIncorrect')::pg_catalog.numeric, -1);

  FOR answer_entry IN
    SELECT item.key, item.value
    FROM pg_catalog.jsonb_each(answers_obj) AS item
  LOOP
    total_questions := total_questions OPERATOR(pg_catalog.+) 1;
    answer_data := answer_entry.value;
    response_data := COALESCE(response_map -> answer_entry.key, '{}'::pg_catalog.jsonb);
    subject_name := COALESCE(NULLIF(answer_data ->> 'subject', ''), 'General');
    subject_scores := pg_catalog.jsonb_set(
      subject_scores,
      ARRAY[subject_name],
      COALESCE(subject_scores -> subject_name, '0'::pg_catalog.jsonb),
      true
    );
    is_attempted := COALESCE(
      (response_data ->> 'status') IN ('ANSWERED', 'ANSWERED_MARKED')
        AND NULLIF(pg_catalog.btrim(response_data ->> 'selected_option'), '') IS NOT NULL,
      false
    );
    is_correct := false;

    IF is_attempted THEN
      IF pg_catalog.upper(COALESCE(answer_data ->> 'type', 'MCQ')) IN ('NUMERICAL', 'NAT') THEN
        user_val := (response_data ->> 'selected_option')::pg_catalog.numeric;
        correct_val := (answer_data ->> 'correct_answer')::pg_catalog.numeric;
        is_correct := pg_catalog.abs(user_val OPERATOR(pg_catalog.-) correct_val)
          OPERATOR(pg_catalog.<) 0.00001;
      ELSE
        is_correct := (response_data ->> 'selected_option')
          OPERATOR(pg_catalog.=) (answer_data ->> 'correct_answer');
      END IF;
    END IF;

    IF NOT is_attempted THEN
      unattempted_count := unattempted_count OPERATOR(pg_catalog.+) 1;
    ELSIF is_correct THEN
      correct_count := correct_count OPERATOR(pg_catalog.+) 1;
      total_score := total_score OPERATOR(pg_catalog.+) marks_correct;
      subject_scores := pg_catalog.jsonb_set(
        subject_scores,
        ARRAY[subject_name],
        pg_catalog.to_jsonb(
          COALESCE((subject_scores ->> subject_name)::pg_catalog.numeric, 0)
            OPERATOR(pg_catalog.+) marks_correct
        ),
        true
      );
    ELSE
      incorrect_count := incorrect_count OPERATOR(pg_catalog.+) 1;
      total_score := total_score OPERATOR(pg_catalog.+) marks_incorrect;
      subject_scores := pg_catalog.jsonb_set(
        subject_scores,
        ARRAY[subject_name],
        pg_catalog.to_jsonb(
          COALESCE((subject_scores ->> subject_name)::pg_catalog.numeric, 0)
            OPERATOR(pg_catalog.+) marks_incorrect
        ),
        true
      );
    END IF;
  END LOOP;

  INSERT INTO public.student_results (
    exam_id,
    student_id,
    student_name,
    total_score,
    max_score,
    correct,
    incorrect,
    unattempted,
    subject_scores,
    submitted_at
  ) VALUES (
    exam_id_param::pg_catalog.text,
    student_row.student_id,
    student_row.name,
    total_score,
    total_questions OPERATOR(pg_catalog.*) marks_correct,
    correct_count,
    incorrect_count,
    unattempted_count,
    subject_scores,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (student_id, exam_id) DO NOTHING;

  DELETE FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_row.id;

  SELECT r.*
  INTO result_row
  FROM public.student_results AS r
  WHERE r.student_id OPERATOR(pg_catalog.=) student_row.student_id
    AND r.exam_id OPERATOR(pg_catalog.=) exam_id_param::pg_catalog.text;

  RETURN pg_catalog.jsonb_build_object(
    'totalScore', result_row.total_score,
    'maxScore', result_row.max_score,
    'correct', result_row.correct,
    'incorrect', result_row.incorrect,
    'unattempted', result_row.unattempted,
    'subjectScores', result_row.subject_scores
  );
END;
$$;


ALTER FUNCTION "public"."submit_exam_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_active_session_progress"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  IF responses_param IS NOT NULL
    AND pg_catalog.octet_length(responses_param::pg_catalog.text) OPERATOR(pg_catalog.>) 262144
  THEN
    RAISE EXCEPTION 'Response payload exceeds 256 KiB';
  END IF;
  PERFORM public.assert_current_student_session();
  RETURN public.sync_active_session_progress_stage3_internal(
    exam_id_param,
    responses_param,
    expected_version_param
  );
END;
$$;


ALTER FUNCTION "public"."sync_active_session_progress"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sync_active_session_progress"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) IS 'Optimistically saves authenticated student progress; named arguments are part of the PostgREST API contract.';



CREATE OR REPLACE FUNCTION "public"."sync_active_session_progress_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_id pg_catalog.text;
  canonical_responses pg_catalog.jsonb;
  new_version pg_catalog.int4;
BEGIN
  SELECT s.*
  INTO student_row
  FROM public.students AS s
  WHERE s.id OPERATOR(pg_catalog.=) auth.uid()
    AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active student profile not found';
  END IF;
  IF expected_version_param IS NULL OR expected_version_param OPERATOR(pg_catalog.<) 1 THEN
    RAISE EXCEPTION 'A positive expected session version is required';
  END IF;

  session_id := student_row.id::pg_catalog.text
    OPERATOR(pg_catalog.||) '_'
    OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      student_row.student_id OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text,
      0
    )
  );

  -- Read only the small columns. The full shuffled paper (jumbled_exam_data)
  -- stays in TOAST storage; its compact response_schema is enough to validate.
  SELECT s.id, s.version, s.deadline_at, s.response_schema
  INTO session_row.id, session_row.version, session_row.deadline_at, session_row.response_schema
  FROM public.active_sessions AS s
  WHERE s.id OPERATOR(pg_catalog.=) session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active session not found or already submitted';
  END IF;

  IF expected_version_param OPERATOR(pg_catalog.<>) session_row.version THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'conflict', true,
      'version', session_row.version,
      'user_responses', (
        SELECT s.user_responses FROM public.active_sessions AS s
        WHERE s.id OPERATOR(pg_catalog.=) session_id
      )
    );
  END IF;
  IF session_row.deadline_at IS NULL
    OR pg_catalog.clock_timestamp() OPERATOR(pg_catalog.>=) session_row.deadline_at
  THEN
    RAISE EXCEPTION 'Exam time has expired; progress was not saved';
  END IF;

  canonical_responses := public.sanitize_exam_responses(
    responses_param,
    COALESCE(
      session_row.response_schema -> 'questions',
      (SELECT s.jumbled_exam_data -> 'questions' FROM public.active_sessions AS s
       WHERE s.id OPERATOR(pg_catalog.=) session_id)
    )
  );
  new_version := session_row.version OPERATOR(pg_catalog.+) 1;
  UPDATE public.active_sessions AS s
  SET user_responses = canonical_responses,
      updated_at = pg_catalog.clock_timestamp(),
      version = new_version
  WHERE s.id OPERATOR(pg_catalog.=) session_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'conflict', false,
    'version', new_version,
    'saved_at', pg_catalog.clock_timestamp()
  );
END;
$$;


ALTER FUNCTION "public"."sync_active_session_progress_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_exam_status_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."sync_exam_status_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_exam_subject_time"("exam_id_param" "uuid", "subject_time_seconds_param" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  student_row public.students%ROWTYPE;
  session_row public.active_sessions%ROWTYPE;
  session_subjects pg_catalog.jsonb;
  session_duration pg_catalog.int4;
  subject_entry pg_catalog.record;
  merged_time pg_catalog.jsonb;
  submitted_seconds pg_catalog.int4;
  previous_seconds pg_catalog.int4;
  submitted_total pg_catalog.int8 := 0;
  elapsed_limit pg_catalog.int8;
BEGIN
  PERFORM public.assert_current_student_session();

  IF exam_id_param IS NULL
    OR subject_time_seconds_param IS NULL
    OR pg_catalog.jsonb_typeof(subject_time_seconds_param) OPERATOR(pg_catalog.<>) 'object'
    OR pg_catalog.octet_length(subject_time_seconds_param::pg_catalog.text) OPERATOR(pg_catalog.>) 4096
  THEN
    RAISE EXCEPTION 'Invalid subject timing payload';
  END IF;

  SELECT student.* INTO student_row
  FROM public.students AS student
  WHERE student.id OPERATOR(pg_catalog.=) auth.uid()
    AND student.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active student profile not found'; END IF;

  -- Only the small columns; subjects and duration come from response_schema.
  SELECT session.id, session.subject_time_seconds, session.started_at,
         COALESCE(session.response_schema -> 'subjects', session.jumbled_exam_data -> 'subjects'),
         COALESCE((session.response_schema ->> 'duration'), (session.jumbled_exam_data ->> 'duration'))::pg_catalog.int4
  INTO session_row.id, session_row.subject_time_seconds, session_row.started_at, session_subjects, session_duration
  FROM public.active_sessions AS session
  WHERE session.id OPERATOR(pg_catalog.=) (
    student_row.id::pg_catalog.text OPERATOR(pg_catalog.||) '_'
      OPERATOR(pg_catalog.||) exam_id_param::pg_catalog.text
  )
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active exam session not found'; END IF;

  merged_time := COALESCE(session_row.subject_time_seconds, '{}'::pg_catalog.jsonb);
  FOR subject_entry IN
    SELECT entry.key, entry.value
    FROM pg_catalog.jsonb_each(subject_time_seconds_param) AS entry
  LOOP
    IF NOT COALESCE(session_subjects, '[]'::pg_catalog.jsonb)
      OPERATOR(pg_catalog.@>) pg_catalog.jsonb_build_array(subject_entry.key)
    THEN
      RAISE EXCEPTION 'Unknown examination subject';
    END IF;
    IF pg_catalog.jsonb_typeof(subject_entry.value) OPERATOR(pg_catalog.<>) 'number'
      OR subject_entry.value::pg_catalog.text !~ '^[0-9]+$'
    THEN
      RAISE EXCEPTION 'Subject time values must be whole non-negative seconds';
    END IF;
    submitted_seconds := subject_entry.value::pg_catalog.text::pg_catalog.int4;
    previous_seconds := COALESCE((merged_time ->> subject_entry.key)::pg_catalog.int4, 0);
    IF submitted_seconds OPERATOR(pg_catalog.<) previous_seconds THEN
      RAISE EXCEPTION 'Subject time cannot move backwards';
    END IF;
    submitted_total := submitted_total OPERATOR(pg_catalog.+) submitted_seconds;
    merged_time := pg_catalog.jsonb_set(
      merged_time,
      ARRAY[subject_entry.key],
      pg_catalog.to_jsonb(submitted_seconds),
      true
    );
  END LOOP;

  elapsed_limit := LEAST(
    GREATEST(COALESCE(session_duration, 180), 1) * 60,
    GREATEST(pg_catalog.floor(EXTRACT(EPOCH FROM (pg_catalog.clock_timestamp() - session_row.started_at)))::pg_catalog.int8, 0)
  ) OPERATOR(pg_catalog.+) 15;
  IF submitted_total OPERATOR(pg_catalog.>) elapsed_limit THEN
    RAISE EXCEPTION 'Subject timing exceeds the elapsed examination time';
  END IF;

  UPDATE public.active_sessions AS session
  SET subject_time_seconds = merged_time
  WHERE session.id OPERATOR(pg_catalog.=) session_row.id;

  RETURN merged_time;
END;
$_$;


ALTER FUNCTION "public"."sync_exam_subject_time"("exam_id_param" "uuid", "subject_time_seconds_param" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."terminate_exam"("exam_id_param" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  PERFORM public.assert_current_student_session();
  PERFORM public.terminate_exam_stage3_internal(exam_id_param);
END;
$$;


ALTER FUNCTION "public"."terminate_exam"("exam_id_param" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."terminate_exam"("exam_id_param" "uuid") IS 'Terminates and finalizes the authenticated student exam; named arguments are part of the PostgREST API contract.';



CREATE OR REPLACE FUNCTION "public"."terminate_exam_stage3_internal"("exam_id_param" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  PERFORM public.submit_exam(exam_id_param, '[]'::pg_catalog.jsonb);
END;
$$;


ALTER FUNCTION "public"."terminate_exam_stage3_internal"("exam_id_param" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_cbt_exams_raw_record"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  v_duration integer;
  v_marks_correct numeric;
  v_marks_incorrect numeric;
  v_subjects_array jsonb;
  v_questions_obj jsonb;
  v_sub_text text;
  v_seen_subjects text[] := ARRAY[]::text[];
  v_seen_qids text[] := ARRAY[]::text[];
  v_total_questions integer := 0;
  v_subject_list jsonb;
  v_q jsonb;
  v_qid text;
  v_qtype text;
  v_options jsonb;
  v_opt_val text;
  v_opt_idx integer;
  v_opt_text text;
  v_opt_img text;
  v_opt_key text;
  v_seen_opts text[];
BEGIN
  IF NEW.title IS NULL OR length(btrim(NEW.title)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters';
  END IF;

  IF NEW.questions_data IS NULL OR jsonb_typeof(NEW.questions_data) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions_data must be a valid JSON object';
  END IF;

  -- Duration
  IF (NEW.questions_data->>'duration') IS NULL OR (NEW.questions_data->>'duration') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be an integer';
  END IF;
  v_duration := (NEW.questions_data->>'duration')::integer;
  IF v_duration NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be between 1 and 600 minutes';
  END IF;

  -- Marks
  v_marks_correct := (NEW.questions_data->>'marksCorrect')::numeric;
  IF v_marks_correct IS NULL OR v_marks_correct NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Exam validation failed: marksCorrect must be between 0 and 100';
  END IF;

  v_marks_incorrect := (NEW.questions_data->>'marksIncorrect')::numeric;
  IF v_marks_incorrect IS NULL OR v_marks_incorrect NOT BETWEEN -100 AND 0 THEN
    RAISE EXCEPTION 'Exam validation failed: marksIncorrect must be between -100 and 0';
  END IF;

  -- Subjects
  v_subjects_array := NEW.questions_data->'subjects';
  IF v_subjects_array IS NULL OR jsonb_typeof(v_subjects_array) <> 'array' OR jsonb_array_length(v_subjects_array) = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: subjects must be a non-empty array';
  END IF;

  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF v_sub_text IS NULL OR length(btrim(v_sub_text)) = 0 THEN
      RAISE EXCEPTION 'Exam validation failed: subject names cannot be empty';
    END IF;
    IF lower(btrim(v_sub_text)) = ANY(v_seen_subjects) THEN
      RAISE EXCEPTION 'Exam validation failed: duplicate subject "%"', v_sub_text;
    END IF;
    v_seen_subjects := array_append(v_seen_subjects, lower(btrim(v_sub_text)));
  END LOOP;

  -- Questions object
  v_questions_obj := NEW.questions_data->'questions';
  IF v_questions_obj IS NULL OR jsonb_typeof(v_questions_obj) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions must be an object';
  END IF;

  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF NOT (v_questions_obj ? v_sub_text) OR jsonb_typeof(v_questions_obj->v_sub_text) <> 'array' THEN
      RAISE EXCEPTION 'Exam validation failed: missing questions array for subject "%"', v_sub_text;
    END IF;
  END LOOP;

  FOR v_sub_text IN SELECT jsonb_object_keys(v_questions_obj) LOOP
    IF NOT (lower(btrim(v_sub_text)) = ANY(v_seen_subjects)) THEN
      RAISE EXCEPTION 'Exam validation failed: undeclared subject "%" in questions', v_sub_text;
    END IF;
  END LOOP;

  -- Questions list
  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    v_subject_list := v_questions_obj->v_sub_text;
    FOR v_q IN SELECT jsonb_array_elements(v_subject_list) LOOP
      v_total_questions := v_total_questions + 1;
      v_qid := btrim(COALESCE(v_q->>'id', ''));
      IF length(v_qid) = 0 THEN
        RAISE EXCEPTION 'Exam validation failed: missing question id';
      END IF;
      IF v_qid = ANY(v_seen_qids) THEN
        RAISE EXCEPTION 'Exam validation failed: duplicate question id "%"', v_qid;
      END IF;
      v_seen_qids := array_append(v_seen_qids, v_qid);

      v_qtype := upper(COALESCE(v_q->>'type', 'MCQ'));
      IF v_qtype NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
        RAISE EXCEPTION 'Exam validation failed: invalid question type "%"', v_qtype;
      END IF;

      IF v_qtype = 'MCQ' THEN
        v_options := v_q->'options';
        IF v_options IS NULL OR jsonb_typeof(v_options) <> 'array' OR jsonb_array_length(v_options) <> 4 THEN
          RAISE EXCEPTION 'Exam validation failed: MCQ "%" must have exactly 4 options', v_qid;
        END IF;

        v_seen_opts := ARRAY[]::text[];
        v_opt_idx := 0;
        FOR v_opt_val IN SELECT jsonb_array_elements_text(v_options) LOOP
          v_opt_text := btrim(COALESCE(v_opt_val, ''));

          v_opt_img := '';
          IF v_q ? 'optionImageUrls' AND jsonb_typeof(v_q->'optionImageUrls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'optionImageUrls'->>v_opt_idx, ''));
          ELSIF v_q ? 'option_image_urls' AND jsonb_typeof(v_q->'option_image_urls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'option_image_urls'->>v_opt_idx, ''));
          END IF;
          IF lower(v_opt_img) = 'null' THEN
            v_opt_img := '';
          END IF;

          IF length(v_opt_text) = 0 AND length(v_opt_img) = 0 THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" option % is missing both text and image', v_qid, v_opt_idx + 1;
          END IF;

          IF length(v_opt_text) > 0 AND length(v_opt_img) > 0 THEN
            v_opt_key := 'mixed:' || lower(v_opt_text) || '|img:' || v_opt_img;
          ELSIF length(v_opt_img) > 0 THEN
            v_opt_key := 'img:' || v_opt_img;
          ELSE
            v_opt_key := 'text:' || lower(v_opt_text);
          END IF;

          IF v_opt_key = ANY(v_seen_opts) THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" contains duplicate options (option %)', v_qid, v_opt_idx + 1;
          END IF;
          v_seen_opts := array_append(v_seen_opts, v_opt_key);
          v_opt_idx := v_opt_idx + 1;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;

  IF v_total_questions = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: exam must contain at least one question';
  END IF;

  RETURN NEW;
END;
$_$;


ALTER FUNCTION "public"."validate_cbt_exams_raw_record"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_exam_required_media_record"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public.assert_exam_required_media(NEW.questions_data);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."validate_exam_required_media_record"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_full_exam_paper"("p_title" "text", "p_questions_data" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
BEGIN
  PERFORM public.assert_exam_payload_bounds(p_questions_data);
  PERFORM public.validate_full_exam_paper_stage1_internal(p_title, p_questions_data);
END;
$$;


ALTER FUNCTION "public"."validate_full_exam_paper"("p_title" "text", "p_questions_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_full_exam_paper_stage1_internal"("p_title" "text", "p_questions_data" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
DECLARE
  v_duration integer;
  v_marks_correct numeric;
  v_marks_incorrect numeric;
  v_subjects_array jsonb;
  v_questions_obj jsonb;
  v_sub_text text;
  v_seen_subjects text[] := ARRAY[]::text[];
  v_seen_qids text[] := ARRAY[]::text[];
  v_total_questions integer := 0;
  v_subject_list jsonb;
  v_q jsonb;
  v_qid text;
  v_qtext text;
  v_qtype text;
  v_options jsonb;
  v_seen_opts text[];
  v_opt_val text;
  v_ans_raw text;
  v_opt_idx integer;
  v_opt_text text;
  v_opt_img text;
  v_opt_key text;
BEGIN
  -- 1. Validate Title
  IF p_title IS NULL OR length(btrim(p_title)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Exam validation failed: title must be between 1 and 200 characters';
  END IF;

  -- 2. Validate Questions Data root
  IF p_questions_data IS NULL OR jsonb_typeof(p_questions_data) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions_data must be a valid JSON object';
  END IF;

  -- 3. Validate Duration (1 to 600 minutes)
  IF (p_questions_data->>'duration') IS NULL OR (p_questions_data->>'duration') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be an integer';
  END IF;
  v_duration := (p_questions_data->>'duration')::integer;
  IF v_duration NOT BETWEEN 1 AND 600 THEN
    RAISE EXCEPTION 'Exam validation failed: duration must be between 1 and 600 minutes';
  END IF;

  -- 4. Validate Marking Scheme
  IF (p_questions_data->>'marksCorrect') IS NULL OR (p_questions_data->>'marksCorrect') !~ '^[+]?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Exam validation failed: marksCorrect must be a positive number';
  END IF;
  v_marks_correct := (p_questions_data->>'marksCorrect')::numeric;
  IF v_marks_correct NOT BETWEEN 0 AND 100 THEN
    RAISE EXCEPTION 'Exam validation failed: marksCorrect must be between 0 and 100';
  END IF;

  IF (p_questions_data->>'marksIncorrect') IS NULL OR (p_questions_data->>'marksIncorrect') !~ '^-?[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Exam validation failed: marksIncorrect must be a number';
  END IF;
  v_marks_incorrect := (p_questions_data->>'marksIncorrect')::numeric;
  IF v_marks_incorrect NOT BETWEEN -100 AND 0 THEN
    RAISE EXCEPTION 'Exam validation failed: marksIncorrect must be between -100 and 0';
  END IF;

  -- 5. Validate Subjects array
  v_subjects_array := p_questions_data->'subjects';
  IF v_subjects_array IS NULL OR jsonb_typeof(v_subjects_array) <> 'array' OR jsonb_array_length(v_subjects_array) = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: subjects must be a non-empty array';
  END IF;

  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF v_sub_text IS NULL OR length(btrim(v_sub_text)) = 0 THEN
      RAISE EXCEPTION 'Exam validation failed: subject names cannot be empty';
    END IF;
    IF lower(btrim(v_sub_text)) = ANY(v_seen_subjects) THEN
      RAISE EXCEPTION 'Exam validation failed: duplicate subject name "%"', v_sub_text;
    END IF;
    v_seen_subjects := array_append(v_seen_subjects, lower(btrim(v_sub_text)));
  END LOOP;

  -- 6. Validate Questions object
  v_questions_obj := p_questions_data->'questions';
  IF v_questions_obj IS NULL OR jsonb_typeof(v_questions_obj) <> 'object' THEN
    RAISE EXCEPTION 'Exam validation failed: questions must be an object mapping subjects to question lists';
  END IF;

  -- Ensure every declared subject exists in questions object
  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    IF NOT (v_questions_obj ? v_sub_text) THEN
      RAISE EXCEPTION 'Exam validation failed: declared subject "%" is missing from questions object', v_sub_text;
    END IF;
    IF jsonb_typeof(v_questions_obj->v_sub_text) <> 'array' THEN
      RAISE EXCEPTION 'Exam validation failed: questions for subject "%" must be a JSON array', v_sub_text;
    END IF;
  END LOOP;

  -- Ensure no extra undeclared subjects in questions object
  FOR v_sub_text IN SELECT jsonb_object_keys(v_questions_obj) LOOP
    IF NOT (lower(btrim(v_sub_text)) = ANY(v_seen_subjects)) THEN
      RAISE EXCEPTION 'Exam validation failed: questions contains undeclared subject "%"', v_sub_text;
    END IF;
  END LOOP;

  -- 7. Validate each question across all subjects
  FOR v_sub_text IN SELECT jsonb_array_elements_text(v_subjects_array) LOOP
    v_subject_list := v_questions_obj->v_sub_text;
    FOR v_q IN SELECT jsonb_array_elements(v_subject_list) LOOP
      v_total_questions := v_total_questions + 1;

      IF jsonb_typeof(v_q) <> 'object' THEN
        RAISE EXCEPTION 'Exam validation failed: question item in subject "%" must be an object', v_sub_text;
      END IF;

      -- Question ID: non-empty, globally unique across entire paper
      v_qid := btrim(COALESCE(v_q->>'id', ''));
      IF length(v_qid) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Exam validation failed: question in subject "%" is missing a valid id (must be 1-120 chars)', v_sub_text;
      END IF;
      IF v_qid = ANY(v_seen_qids) THEN
        RAISE EXCEPTION 'Exam validation failed: duplicate question id "%" detected', v_qid;
      END IF;
      v_seen_qids := array_append(v_seen_qids, v_qid);

      -- Prompt: text or question image required
      v_qtext := btrim(COALESCE(v_q->>'text', v_q->>'question_text', ''));
      IF length(v_qtext) = 0
         AND length(btrim(COALESCE(v_q->>'questionImageUrl', v_q->>'imageUrl', ''))) = 0 THEN
        RAISE EXCEPTION 'Exam validation failed: question "%" must have question text or a question image', v_qid;
      END IF;

      -- Question Type
      v_qtype := upper(COALESCE(v_q->>'type', 'MCQ'));
      IF v_qtype NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN
        RAISE EXCEPTION 'Exam validation failed: question "%" has unsupported type "%"', v_qid, v_qtype;
      END IF;

      -- Options & Correct Answer
      v_ans_raw := btrim(COALESCE(v_q->>'correctAnswer', v_q->>'correct_answer', ''));

      IF v_qtype = 'MCQ' THEN
        v_options := v_q->'options';
        IF v_options IS NULL OR jsonb_typeof(v_options) <> 'array' OR jsonb_array_length(v_options) <> 4 THEN
          RAISE EXCEPTION 'Exam validation failed: MCQ question "%" must have exactly 4 options', v_qid;
        END IF;

        v_seen_opts := ARRAY[]::text[];
        v_opt_idx := 0;
        FOR v_opt_val IN SELECT jsonb_array_elements_text(v_options) LOOP
          v_opt_text := btrim(COALESCE(v_opt_val, ''));

          -- Extract option image from optionImageUrls or option_image_urls
          v_opt_img := '';
          IF v_q ? 'optionImageUrls' AND jsonb_typeof(v_q->'optionImageUrls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'optionImageUrls'->>v_opt_idx, ''));
          ELSIF v_q ? 'option_image_urls' AND jsonb_typeof(v_q->'option_image_urls') = 'array' THEN
            v_opt_img := btrim(COALESCE(v_q->'option_image_urls'->>v_opt_idx, ''));
          END IF;
          IF lower(v_opt_img) = 'null' THEN
            v_opt_img := '';
          END IF;

          -- Reject only when both text and image are absent
          IF length(v_opt_text) = 0 AND length(v_opt_img) = 0 THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" option % is missing both text and image', v_qid, v_opt_idx + 1;
          END IF;

          -- Construct normalized option key for uniqueness check
          IF length(v_opt_text) > 0 AND length(v_opt_img) > 0 THEN
            v_opt_key := 'mixed:' || lower(v_opt_text) || '|img:' || v_opt_img;
          ELSIF length(v_opt_img) > 0 THEN
            v_opt_key := 'img:' || v_opt_img;
          ELSE
            v_opt_key := 'text:' || lower(v_opt_text);
          END IF;

          IF v_opt_key = ANY(v_seen_opts) THEN
            RAISE EXCEPTION 'Exam validation failed: MCQ question "%" contains duplicate options (option %)', v_qid, v_opt_idx + 1;
          END IF;
          v_seen_opts := array_append(v_seen_opts, v_opt_key);
          v_opt_idx := v_opt_idx + 1;
        END LOOP;

        -- Normalize A, B, C, D to 0, 1, 2, 3
        IF upper(v_ans_raw) IN ('A', 'B', 'C', 'D') THEN
          v_ans_raw := (ascii(upper(v_ans_raw)) - 65)::text;
        END IF;
        IF v_ans_raw NOT IN ('0', '1', '2', '3') THEN
          RAISE EXCEPTION 'Exam validation failed: MCQ question "%" has invalid correct answer "%" (must be 0, 1, 2, or 3)', v_qid, v_ans_raw;
        END IF;

      ELSIF v_qtype IN ('NUMERICAL', 'NAT') THEN
        IF v_q ? 'options' AND jsonb_typeof(v_q->'options') = 'array' AND jsonb_array_length(v_q->'options') > 0 THEN
          RAISE EXCEPTION 'Exam validation failed: Numerical question "%" must not have multiple-choice options', v_qid;
        END IF;

        IF v_ans_raw !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
          RAISE EXCEPTION 'Exam validation failed: Numerical question "%" has invalid non-numeric answer "%"', v_qid, v_ans_raw;
        END IF;
      END IF;

    END LOOP;
  END LOOP;

  -- 8. Ensure at least one question
  IF v_total_questions = 0 THEN
    RAISE EXCEPTION 'Exam validation failed: exam must contain at least one question';
  END IF;
END;
$_$;


ALTER FUNCTION "public"."validate_full_exam_paper_stage1_internal"("p_title" "text", "p_questions_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_question_bank_content"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $_$
DECLARE
  option_index integer;
  option_text text;
  option_image text;
  option_key text;
  seen_keys text[] := ARRAY[]::text[];
  canonical_subject text;
BEGIN
  NEW.subject := btrim(NEW.subject);
  NEW.type := upper(NEW.type);
  NEW.question_text := btrim(NEW.question_text);
  NEW.correct_answer := btrim(NEW.correct_answer);

  -- Subjects are administrator-configured. New questions, and questions moved to
  -- another subject, must use an active subject; existing questions keep working
  -- after their subject is deactivated.
  IF TG_OP = 'INSERT' OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    canonical_subject := public.resolve_active_subject(NEW.subject);
    IF canonical_subject IS NULL THEN
      RAISE EXCEPTION 'Question subject "%" is not an active subject. Add or reactivate it under Subjects & Patterns.', NEW.subject;
    END IF;
    NEW.subject := canonical_subject;
  END IF;
  IF NEW.type NOT IN ('MCQ', 'NUMERICAL', 'NAT') THEN RAISE EXCEPTION 'Question type is invalid'; END IF;
  IF length(NEW.question_text) > 10000 THEN RAISE EXCEPTION 'Question text must not exceed 10000 characters'; END IF;
  IF NEW.question_text = '' AND length(btrim(COALESCE(NEW.question_image_url, ''))) = 0 THEN
    RAISE EXCEPTION 'Question text or a question image is required';
  END IF;
  IF NEW.question_image_url IS NOT NULL AND length(NEW.question_image_url) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'Question image reference is invalid';
  END IF;

  IF NEW.type = 'MCQ' THEN
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 4
       OR NEW.correct_answer !~ '^[0-3]$' THEN
      RAISE EXCEPTION 'MCQ requires four options and a correct answer from 0 to 3';
    END IF;
    IF NEW.option_image_urls IS NOT NULL
       AND (jsonb_typeof(NEW.option_image_urls) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.option_image_urls) <> 4) THEN
      RAISE EXCEPTION 'MCQ option image references must contain exactly four positions';
    END IF;
    FOR option_index IN 0..3 LOOP
      IF jsonb_typeof(NEW.options->option_index) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Every MCQ option text value must be a string';
      END IF;
      option_text := btrim(COALESCE(NEW.options->>option_index, ''));
      option_image := btrim(COALESCE(NEW.option_image_urls->>option_index, ''));
      IF length(option_text) > 5000 THEN RAISE EXCEPTION 'MCQ option text must not exceed 5000 characters'; END IF;
      IF length(option_image) > 2048 THEN RAISE EXCEPTION 'MCQ option image reference is too long'; END IF;
      IF option_text = '' AND option_image = '' THEN RAISE EXCEPTION 'Every MCQ option requires text or an image'; END IF;
      option_key := CASE WHEN option_image <> '' THEN 'img:' || option_image ELSE 'text:' || public.canonical_question_text(option_text) END;
      IF option_key = ANY(seen_keys) THEN RAISE EXCEPTION 'MCQ options must be unique'; END IF;
      seen_keys := array_append(seen_keys, option_key);
    END LOOP;
  ELSE
    IF jsonb_typeof(NEW.options) IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.options) <> 0
       OR length(NEW.correct_answer) NOT BETWEEN 1 AND 100
       OR NEW.correct_answer !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' THEN
      RAISE EXCEPTION 'Numerical questions require no options and a valid numeric answer';
    END IF;
    IF NEW.option_image_urls IS NOT NULL AND NEW.option_image_urls <> '[]'::jsonb
       AND NEW.option_image_urls <> '[null, null, null, null]'::jsonb THEN
      RAISE EXCEPTION 'Numerical questions cannot retain option images';
    END IF;
    NEW.option_image_urls := '[]'::jsonb;
  END IF;
  NEW.has_image_or_diagram := COALESCE(NEW.has_image_or_diagram, false) OR NEW.question_image_url IS NOT NULL;
  RETURN NEW;
END;
$_$;


ALTER FUNCTION "public"."validate_question_bank_content"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_result_exam_reference"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
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


ALTER FUNCTION "public"."validate_result_exam_reference"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_student_record"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $_$
BEGIN
  IF NEW.student_id !~ '^[A-Za-z0-9._-]{2,64}$'
     OR length(btrim(NEW.name)) NOT BETWEEN 1 AND 120
     OR (NEW.class IS NOT NULL AND length(btrim(NEW.class)) NOT BETWEEN 1 AND 120)
     OR (NEW.section IS NOT NULL AND length(btrim(NEW.section)) NOT BETWEEN 1 AND 32) THEN
    RAISE EXCEPTION 'Student identity data is invalid';
  END IF;
  RETURN NEW;
END;
$_$;


ALTER FUNCTION "public"."validate_student_record"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."active_sessions" (
    "id" "text" NOT NULL,
    "student_id" "text" NOT NULL,
    "exam_id" "text" NOT NULL,
    "user_responses" "jsonb",
    "jumbled_exam_data" "jsonb",
    "time_left" integer,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "started_at" timestamp with time zone,
    "version" integer DEFAULT 1 NOT NULL,
    "deadline_at" timestamp with time zone,
    "subject_time_seconds" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "response_schema" "jsonb",
    CONSTRAINT "active_sessions_subject_time_object" CHECK (("jsonb_typeof"("subject_time_seconds") = 'object'::"text"))
);


ALTER TABLE "public"."active_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "occurred_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "admin_audit_events_action_check" CHECK ((("length"("action") >= 1) AND ("length"("action") <= 80))),
    CONSTRAINT "admin_audit_events_metadata_check" CHECK (("jsonb_typeof"("metadata") = 'object'::"text")),
    CONSTRAINT "admin_audit_events_target_type_check" CHECK ((("length"("target_type") >= 1) AND ("length"("target_type") <= 80)))
);


ALTER TABLE "public"."admin_audit_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."application_owner" (
    "singleton" boolean DEFAULT true NOT NULL,
    "user_id" "uuid" NOT NULL,
    CONSTRAINT "application_owner_singleton_check" CHECK ("singleton")
);


ALTER TABLE "public"."application_owner" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cbt_exam_answers" (
    "exam_id" "uuid" NOT NULL,
    "answers" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."cbt_exam_answers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cbt_exams_raw" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "questions_data" "jsonb" NOT NULL,
    "class" "text",
    "section" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "cbt_exams_data_valid" CHECK (((("length"("btrim"("title")) >= 1) AND ("length"("btrim"("title")) <= 200)) AND ("jsonb_typeof"("questions_data") = 'object'::"text") AND ("jsonb_typeof"(("questions_data" -> 'subjects'::"text")) = 'array'::"text") AND ("jsonb_array_length"(("questions_data" -> 'subjects'::"text")) > 0) AND ("jsonb_typeof"(("questions_data" -> 'questions'::"text")) = 'object'::"text") AND (COALESCE(("questions_data" ->> 'duration'::"text"), ''::"text") ~ '^[0-9]+$'::"text") AND (((("questions_data" ->> 'duration'::"text"))::integer >= 1) AND ((("questions_data" ->> 'duration'::"text"))::integer <= 600)) AND (COALESCE(("questions_data" ->> 'marksCorrect'::"text"), ''::"text") ~ '^[+]?[0-9]+([.][0-9]+)?$'::"text") AND (((("questions_data" ->> 'marksCorrect'::"text"))::numeric >= (0)::numeric) AND ((("questions_data" ->> 'marksCorrect'::"text"))::numeric <= (100)::numeric)) AND (COALESCE(("questions_data" ->> 'marksIncorrect'::"text"), ''::"text") ~ '^-?[0-9]+([.][0-9]+)?$'::"text") AND (((("questions_data" ->> 'marksIncorrect'::"text"))::numeric >= ('-100'::integer)::numeric) AND ((("questions_data" ->> 'marksIncorrect'::"text"))::numeric <= (0)::numeric)))),
    CONSTRAINT "cbt_exams_status_valid" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'ACTIVE'::"text", 'ENDED'::"text"])))
);


ALTER TABLE "public"."cbt_exams_raw" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."cbt_exams" WITH ("security_invoker"='true') AS
 SELECT "id",
    "title",
    "status",
    "class",
    "section",
    "created_at",
    "public"."exam_questions_for_viewer"("id") AS "questions_data"
   FROM "public"."cbt_exams_raw" "r";


ALTER VIEW "public"."cbt_exams" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."classes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "sections" "text"[] DEFAULT '{}'::"text"[],
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()),
    CONSTRAINT "classes_data_valid" CHECK (((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 120)) AND ("cardinality"("sections") > 0) AND ("array_position"("sections", ''::"text") IS NULL)))
);


ALTER TABLE "public"."classes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exam_status_events" (
    "exam_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "status" "text" NOT NULL,
    "class" "text",
    "section" "text",
    "changed_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "exam_status_events_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'ACTIVE'::"text", 'ENDED'::"text", 'DELETED'::"text"])))
);


ALTER TABLE "public"."exam_status_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exam_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "duration_minutes" integer NOT NULL,
    "marks_correct" numeric(6,2) NOT NULL,
    "marks_incorrect" numeric(6,2) NOT NULL,
    "sections" "jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "exam_templates_description_check" CHECK (("length"("description") <= 500)),
    CONSTRAINT "exam_templates_duration_minutes_check" CHECK ((("duration_minutes" >= 1) AND ("duration_minutes" <= 600))),
    CONSTRAINT "exam_templates_marks_correct_check" CHECK ((("marks_correct" > (0)::numeric) AND ("marks_correct" <= (100)::numeric))),
    CONSTRAINT "exam_templates_marks_incorrect_check" CHECK ((("marks_incorrect" >= ('-100'::integer)::numeric) AND ("marks_incorrect" <= (0)::numeric))),
    CONSTRAINT "exam_templates_name_check" CHECK ((("name" = "btrim"("name")) AND (("length"("name") >= 1) AND ("length"("name") <= 80)))),
    CONSTRAINT "exam_templates_sections_check" CHECK (("jsonb_typeof"("sections") = 'array'::"text"))
);


ALTER TABLE "public"."exam_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_name" "text" NOT NULL,
    "total_questions" integer NOT NULL,
    "successful_imports" integer NOT NULL,
    "rejected_questions" integer NOT NULL,
    "status" "text" NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."import_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."managed_administrators" (
    "user_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."managed_administrators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "role" "text" DEFAULT 'student'::"text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "profiles_role_valid" CHECK (("role" = ANY (ARRAY['student'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."question_bank" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category" "text" DEFAULT 'Mains'::"text" NOT NULL,
    "subject" "text" NOT NULL,
    "type" "text" NOT NULL,
    "question_text" "text" NOT NULL,
    "options" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "correct_answer" "text" NOT NULL,
    "points" integer DEFAULT 4 NOT NULL,
    "neg_points" integer DEFAULT '-1'::integer NOT NULL,
    "explanation" "text",
    "chapter" "text",
    "difficulty" "text",
    "question_image_url" "text",
    "option_image_urls" "jsonb",
    "has_image_or_diagram" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "question_bank_data_valid" CHECK ((("type" = ANY (ARRAY['MCQ'::"text", 'NUMERICAL'::"text", 'NAT'::"text"])) AND (("length"("btrim"("subject")) >= 1) AND ("length"("btrim"("subject")) <= 120)) AND ((("type" = 'MCQ'::"text") AND ("jsonb_typeof"("options") = 'array'::"text") AND ("jsonb_array_length"("options") = 4) AND ("correct_answer" = ANY (ARRAY['0'::"text", '1'::"text", '2'::"text", '3'::"text"]))) OR (("type" = ANY (ARRAY['NUMERICAL'::"text", 'NAT'::"text"])) AND ("jsonb_typeof"("options") = 'array'::"text") AND ("jsonb_array_length"("options") = 0) AND ("correct_answer" ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'::"text")))))
);


ALTER TABLE "public"."question_bank" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."question_import_batches" (
    "batch_id" "uuid" NOT NULL,
    "imported_by" "uuid" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "file_name" "text" NOT NULL,
    "question_count" integer NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "question_import_batches_file_name_check" CHECK ((("length"("btrim"("file_name")) >= 1) AND ("length"("btrim"("file_name")) <= 255))),
    CONSTRAINT "question_import_batches_payload_hash_check" CHECK (("length"("payload_hash") = 32)),
    CONSTRAINT "question_import_batches_question_count_check" CHECK ((("question_count" >= 1) AND ("question_count" <= 500)))
);


ALTER TABLE "public"."question_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."student_result_reviews" (
    "result_id" "uuid" NOT NULL,
    "exam_id" "uuid" NOT NULL,
    "student_id" "text" NOT NULL,
    "response_snapshot" "jsonb" NOT NULL,
    "subject_time_seconds" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    CONSTRAINT "student_result_reviews_response_object" CHECK (("jsonb_typeof"("response_snapshot") = 'object'::"text")),
    CONSTRAINT "student_result_reviews_time_object" CHECK (("jsonb_typeof"("subject_time_seconds") = 'object'::"text"))
);


ALTER TABLE "public"."student_result_reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."student_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "exam_id" "text" NOT NULL,
    "student_id" "text" NOT NULL,
    "student_name" "text",
    "total_score" numeric,
    "max_score" numeric,
    "correct" integer,
    "incorrect" integer,
    "unattempted" integer,
    "subject_scores" "jsonb",
    "submitted_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."student_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."students" (
    "id" "uuid" NOT NULL,
    "student_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "class" "text",
    "section" "text",
    "active_auth_session_id" "uuid",
    "archived_at" timestamp with time zone,
    "archived_by" "uuid",
    "archive_reason" "text",
    CONSTRAINT "students_archive_state_valid" CHECK (((("archived_at" IS NULL) AND ("archived_by" IS NULL) AND ("archive_reason" IS NULL)) OR (("archived_at" IS NOT NULL) AND ("archived_by" IS NOT NULL) AND (("length"("btrim"("archive_reason")) >= 3) AND ("length"("btrim"("archive_reason")) <= 500)))))
);


ALTER TABLE "public"."students" OWNER TO "postgres";


COMMENT ON COLUMN "public"."students"."active_auth_session_id" IS 'Supabase Auth JWT session_id currently authorized for student exam operations.';



CREATE TABLE IF NOT EXISTS "public"."subjects" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "display_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subjects_display_order_check" CHECK (("display_order" >= 0)),
    CONSTRAINT "subjects_name_check" CHECK ((("name" = "btrim"("name")) AND (("length"("name") >= 1) AND ("length"("name") <= 60)) AND ("name" ~ '^[[:alnum:]][[:alnum:] &().,/+''-]*$'::"text")))
);


ALTER TABLE "public"."subjects" OWNER TO "postgres";


ALTER TABLE ONLY "public"."active_sessions"
    ADD CONSTRAINT "active_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."admin_audit_events"
    ADD CONSTRAINT "admin_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."application_owner"
    ADD CONSTRAINT "application_owner_pkey" PRIMARY KEY ("singleton");



ALTER TABLE ONLY "public"."application_owner"
    ADD CONSTRAINT "application_owner_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."cbt_exam_answers"
    ADD CONSTRAINT "cbt_exam_answers_pkey" PRIMARY KEY ("exam_id");



ALTER TABLE ONLY "public"."cbt_exams_raw"
    ADD CONSTRAINT "cbt_exams_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exam_status_events"
    ADD CONSTRAINT "exam_status_events_pkey" PRIMARY KEY ("exam_id");



ALTER TABLE ONLY "public"."exam_templates"
    ADD CONSTRAINT "exam_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_history"
    ADD CONSTRAINT "import_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."managed_administrators"
    ADD CONSTRAINT "managed_administrators_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."question_bank"
    ADD CONSTRAINT "question_bank_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."question_import_batches"
    ADD CONSTRAINT "question_import_batches_pkey" PRIMARY KEY ("batch_id");



ALTER TABLE ONLY "public"."student_result_reviews"
    ADD CONSTRAINT "student_result_reviews_pkey" PRIMARY KEY ("result_id");



ALTER TABLE ONLY "public"."student_results"
    ADD CONSTRAINT "student_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."student_results"
    ADD CONSTRAINT "student_results_student_exam_key" UNIQUE ("student_id", "exam_id");



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_student_id_key" UNIQUE ("student_id");



ALTER TABLE ONLY "public"."subjects"
    ADD CONSTRAINT "subjects_pkey" PRIMARY KEY ("id");



CREATE INDEX "active_sessions_deadline_idx" ON "public"."active_sessions" USING "btree" ("deadline_at");



CREATE INDEX "active_sessions_exam_id_idx" ON "public"."active_sessions" USING "btree" ("exam_id");



CREATE INDEX "active_sessions_student_id_idx" ON "public"."active_sessions" USING "btree" ("student_id");



CREATE INDEX "admin_audit_events_occurred_idx" ON "public"."admin_audit_events" USING "btree" ("occurred_at" DESC, "id" DESC);



CREATE INDEX "cbt_exams_active_idx" ON "public"."cbt_exams_raw" USING "btree" ("id") WHERE ("status" = 'ACTIVE'::"text");



CREATE INDEX "cbt_exams_admin_list_idx" ON "public"."cbt_exams_raw" USING "btree" ("status", "created_at" DESC, "id");



CREATE INDEX "cbt_exams_assignment_idx" ON "public"."cbt_exams_raw" USING "btree" ("class", "section", "created_at" DESC);



CREATE INDEX "cbt_exams_created_id_idx" ON "public"."cbt_exams_raw" USING "btree" ("created_at" DESC, "id");



CREATE INDEX "exam_status_events_assignment_idx" ON "public"."exam_status_events" USING "btree" ("status", "class", "section", "changed_at" DESC);



CREATE UNIQUE INDEX "exam_templates_name_ci_key" ON "public"."exam_templates" USING "btree" ("lower"("name"));



CREATE INDEX "managed_administrators_created_by_idx" ON "public"."managed_administrators" USING "btree" ("created_by");



CREATE INDEX "question_bank_admin_browse_idx" ON "public"."question_bank" USING "btree" ("subject", "type", "created_at", "id");



CREATE UNIQUE INDEX "question_bank_canonical_text_unique" ON "public"."question_bank" USING "btree" ("md5"("public"."canonical_question_text"("question_text"))) WHERE ("public"."canonical_question_text"("question_text") <> ''::"text");



CREATE INDEX "question_bank_created_id_idx" ON "public"."question_bank" USING "btree" ("created_at", "id");



CREATE INDEX "question_bank_missing_required_media_idx" ON "public"."question_bank" USING "btree" ("id") WHERE (("has_image_or_diagram" = true) AND ("length"("btrim"(COALESCE("question_image_url", ''::"text"))) = 0));



CREATE INDEX "question_bank_subject_created_idx" ON "public"."question_bank" USING "btree" ("subject", "created_at");



CREATE INDEX "student_results_exam_id_idx" ON "public"."student_results" USING "btree" ("exam_id");



CREATE INDEX "student_results_exam_score_order_idx" ON "public"."student_results" USING "btree" ("exam_id", "total_score" DESC, "student_id", "id");



CREATE INDEX "student_results_exam_student_idx" ON "public"."student_results" USING "btree" ("exam_id", "student_id");



CREATE INDEX "student_results_student_id_idx" ON "public"."student_results" USING "btree" ("student_id");



CREATE INDEX "students_active_roster_idx" ON "public"."students" USING "btree" ("class", "section", "student_id") WHERE ("archived_at" IS NULL);



CREATE INDEX "students_active_roster_order_idx" ON "public"."students" USING "btree" ("lower"("student_id"), "id") WHERE ("archived_at" IS NULL);



CREATE INDEX "students_archived_idx" ON "public"."students" USING "btree" ("archived_at") WHERE ("archived_at" IS NOT NULL);



CREATE INDEX "students_roster_filter_order_idx" ON "public"."students" USING "btree" ("class", "section", "lower"("student_id"), "id");



CREATE INDEX "subjects_display_order_idx" ON "public"."subjects" USING "btree" ("display_order", "name");



CREATE UNIQUE INDEX "subjects_name_ci_key" ON "public"."subjects" USING "btree" ("lower"("name"));



CREATE OR REPLACE TRIGGER "audit_class_admin_change_trigger" AFTER INSERT OR UPDATE ON "public"."classes" FOR EACH ROW EXECUTE FUNCTION "public"."audit_class_admin_change"();



CREATE OR REPLACE TRIGGER "audit_exam_admin_change_trigger" AFTER INSERT OR UPDATE ON "public"."cbt_exams_raw" FOR EACH ROW EXECUTE FUNCTION "public"."audit_exam_admin_change"();



CREATE OR REPLACE TRIGGER "audit_provisioned_student_trigger" AFTER INSERT ON "public"."students" FOR EACH ROW EXECUTE FUNCTION "public"."audit_provisioned_student"();



CREATE OR REPLACE TRIGGER "audit_question_admin_change_trigger" AFTER INSERT OR UPDATE ON "public"."question_bank" FOR EACH ROW EXECUTE FUNCTION "public"."audit_question_admin_change"();



CREATE OR REPLACE TRIGGER "block_direct_cbt_exam_answers_writes_trigger" BEFORE INSERT OR DELETE OR UPDATE ON "public"."cbt_exam_answers" FOR EACH STATEMENT EXECUTE FUNCTION "public"."block_direct_cbt_exams_raw_writes"();



CREATE OR REPLACE TRIGGER "block_direct_cbt_exams_raw_writes_trigger" BEFORE INSERT OR DELETE OR UPDATE ON "public"."cbt_exams_raw" FOR EACH STATEMENT EXECUTE FUNCTION "public"."block_direct_cbt_exams_raw_writes"();



CREATE OR REPLACE TRIGGER "capture_student_result_review_after_insert" AFTER INSERT ON "public"."student_results" FOR EACH ROW EXECUTE FUNCTION "public"."capture_student_result_review"();



CREATE OR REPLACE TRIGGER "cbt_exams_modification_trigger" INSTEAD OF INSERT OR DELETE OR UPDATE ON "public"."cbt_exams" FOR EACH ROW EXECUTE FUNCTION "public"."handle_cbt_exams_modification"();



CREATE OR REPLACE TRIGGER "protect_class_deletion_trigger" BEFORE DELETE ON "public"."classes" FOR EACH ROW EXECUTE FUNCTION "public"."protect_class_deletion"();



CREATE OR REPLACE TRIGGER "protect_committed_student_results_trigger" BEFORE DELETE OR UPDATE ON "public"."student_results" FOR EACH ROW EXECUTE FUNCTION "public"."protect_committed_student_results"();



CREATE OR REPLACE TRIGGER "protect_exam_deletion_trigger" BEFORE DELETE ON "public"."cbt_exams_raw" FOR EACH ROW EXECUTE FUNCTION "public"."protect_exam_deletion"();



CREATE OR REPLACE TRIGGER "protect_inactive_student_assignment_trigger" BEFORE UPDATE OF "class", "section" ON "public"."students" FOR EACH ROW EXECUTE FUNCTION "public"."protect_inactive_student_assignment"();



CREATE OR REPLACE TRIGGER "set_session_response_schema_trigger" BEFORE INSERT OR UPDATE OF "jumbled_exam_data" ON "public"."active_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."set_session_response_schema"();



CREATE OR REPLACE TRIGGER "sync_exam_status_event_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."cbt_exams_raw" FOR EACH ROW EXECUTE FUNCTION "public"."sync_exam_status_event"();



CREATE OR REPLACE TRIGGER "validate_active_session_exam_reference_trigger" BEFORE INSERT OR UPDATE OF "exam_id" ON "public"."active_sessions" FOR EACH ROW EXECUTE FUNCTION "public"."validate_result_exam_reference"();



CREATE OR REPLACE TRIGGER "validate_cbt_exams_raw_trigger" BEFORE INSERT OR UPDATE OF "title", "questions_data" ON "public"."cbt_exams_raw" FOR EACH ROW EXECUTE FUNCTION "public"."validate_cbt_exams_raw_record"();



CREATE OR REPLACE TRIGGER "validate_exam_required_media_trigger" BEFORE INSERT OR UPDATE OF "questions_data" ON "public"."cbt_exams_raw" FOR EACH ROW EXECUTE FUNCTION "public"."validate_exam_required_media_record"();



CREATE OR REPLACE TRIGGER "validate_question_bank_content_trigger" BEFORE INSERT OR UPDATE ON "public"."question_bank" FOR EACH ROW EXECUTE FUNCTION "public"."validate_question_bank_content"();



CREATE OR REPLACE TRIGGER "validate_result_exam_reference_trigger" BEFORE INSERT OR UPDATE OF "exam_id" ON "public"."student_results" FOR EACH ROW EXECUTE FUNCTION "public"."validate_result_exam_reference"();



CREATE OR REPLACE TRIGGER "validate_student_record_trigger" BEFORE INSERT OR UPDATE OF "student_id", "name", "class", "section" ON "public"."students" FOR EACH ROW EXECUTE FUNCTION "public"."validate_student_record"();



ALTER TABLE ONLY "public"."application_owner"
    ADD CONSTRAINT "application_owner_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."cbt_exam_answers"
    ADD CONSTRAINT "cbt_exam_answers_exam_id_fkey" FOREIGN KEY ("exam_id") REFERENCES "public"."cbt_exams_raw"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."managed_administrators"
    ADD CONSTRAINT "managed_administrators_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."application_owner"("user_id");



ALTER TABLE ONLY "public"."managed_administrators"
    ADD CONSTRAINT "managed_administrators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."student_result_reviews"
    ADD CONSTRAINT "student_result_reviews_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "public"."student_results"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."students"
    ADD CONSTRAINT "students_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."active_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "active_sessions_admin_insert" ON "public"."active_sessions" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin_aal2"());



CREATE POLICY "active_sessions_admin_update" ON "public"."active_sessions" FOR UPDATE TO "authenticated" USING ("public"."is_admin_aal2"()) WITH CHECK ("public"."is_admin_aal2"());



CREATE POLICY "active_sessions_select_own" ON "public"."active_sessions" FOR SELECT TO "authenticated" USING ((( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2") OR (EXISTS ( SELECT 1
   FROM "public"."students" "student"
  WHERE (("student"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("student"."student_id" = "active_sessions"."student_id") AND ("student"."active_auth_session_id" = ( SELECT "public"."current_auth_session_id"() AS "current_auth_session_id")))))));



ALTER TABLE "public"."admin_audit_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_audit_events_read_aal2" ON "public"."admin_audit_events" FOR SELECT TO "authenticated" USING ("public"."is_admin_aal2"());



ALTER TABLE "public"."application_owner" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cbt_exam_answers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cbt_exam_answers_admin_select" ON "public"."cbt_exam_answers" FOR SELECT TO "authenticated" USING ("public"."is_admin_aal2"());



ALTER TABLE "public"."cbt_exams_raw" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cbt_exams_read_assigned" ON "public"."cbt_exams_raw" FOR SELECT TO "authenticated" USING ((( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("s"."archived_at" IS NULL) AND (("cbt_exams_raw"."class" IS NULL) OR ("cbt_exams_raw"."class" = 'All'::"text") OR ("s"."class" = "cbt_exams_raw"."class")) AND (("cbt_exams_raw"."section" IS NULL) OR ("cbt_exams_raw"."section" = 'All'::"text") OR ("s"."section" = "cbt_exams_raw"."section")))))));



ALTER TABLE "public"."classes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "classes_admin_delete" ON "public"."classes" FOR DELETE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "classes_admin_insert" ON "public"."classes" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "classes_admin_update" ON "public"."classes" FOR UPDATE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2")) WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "classes_read" ON "public"."classes" FOR SELECT TO "authenticated" USING ((( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("s"."archived_at" IS NULL))))));



ALTER TABLE "public"."exam_status_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "exam_status_events_read_assigned" ON "public"."exam_status_events" FOR SELECT TO "authenticated" USING ((( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("s"."archived_at" IS NULL) AND (("exam_status_events"."class" IS NULL) OR ("exam_status_events"."class" = 'All'::"text") OR ("exam_status_events"."class" = "s"."class")) AND (("exam_status_events"."section" IS NULL) OR ("exam_status_events"."section" = 'All'::"text") OR ("exam_status_events"."section" = "s"."section")))))));



ALTER TABLE "public"."exam_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."import_history" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_history_admin_read_aal2" ON "public"."import_history" FOR SELECT TO "authenticated" USING ("public"."is_admin_aal2"());



ALTER TABLE "public"."managed_administrators" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "owner_reads_administrators" ON "public"."managed_administrators" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_root_developer"() AS "is_root_developer"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_admin_delete" ON "public"."profiles" FOR DELETE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "profiles_admin_insert" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "profiles_admin_update" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2")) WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "profiles_read_own" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = ( SELECT "auth"."uid"() AS "uid")) OR ( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2")));



ALTER TABLE "public"."question_bank" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "question_bank_admin_delete" ON "public"."question_bank" FOR DELETE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "question_bank_admin_insert" ON "public"."question_bank" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "question_bank_admin_select" ON "public"."question_bank" FOR SELECT TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "question_bank_admin_update" ON "public"."question_bank" FOR UPDATE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2")) WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



ALTER TABLE "public"."question_import_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "question_import_batches_read_aal2" ON "public"."question_import_batches" FOR SELECT TO "authenticated" USING ("public"."is_admin_aal2"());



ALTER TABLE "public"."student_result_reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."student_results" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "student_results_read_own" ON "public"."student_results" FOR SELECT TO "authenticated" USING ((( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2") OR (EXISTS ( SELECT 1
   FROM "public"."students" "s"
  WHERE (("s"."id" = ( SELECT "auth"."uid"() AS "uid")) AND ("s"."archived_at" IS NULL) AND ("s"."student_id" = "student_results"."student_id"))))));



ALTER TABLE "public"."students" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "students_admin_delete" ON "public"."students" FOR DELETE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "students_admin_insert" ON "public"."students" FOR INSERT TO "authenticated" WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "students_admin_update" ON "public"."students" FOR UPDATE TO "authenticated" USING (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2")) WITH CHECK (( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2"));



CREATE POLICY "students_read_own" ON "public"."students" FOR SELECT TO "authenticated" USING (((("id" = ( SELECT "auth"."uid"() AS "uid")) AND ("archived_at" IS NULL)) OR ( SELECT "public"."is_admin_aal2"() AS "is_admin_aal2")));



ALTER TABLE "public"."subjects" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_clear_question_bank"("confirmation_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_clear_question_bank"("confirmation_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_clear_question_bank"("confirmation_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_deactivate_students"("user_ids_param" "uuid"[], "reason_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_deactivate_students"("user_ids_param" "uuid"[], "reason_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_deactivate_students"("user_ids_param" "uuid"[], "reason_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_delete_empty_class"("class_id_param" "uuid", "expected_name_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_empty_class"("class_id_param" "uuid", "expected_name_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_delete_empty_class"("class_id_param" "uuid", "expected_name_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_delete_exam_template"("template_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_exam_template"("template_id_param" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_delete_question"("question_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_question"("question_id_param" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_delete_question"("question_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_delete_subject"("subject_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_subject"("subject_id_param" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_delete_unused_exam"("exam_id_param" "uuid", "expected_title_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_unused_exam"("exam_id_param" "uuid", "expected_title_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_delete_unused_exam"("exam_id_param" "uuid", "expected_title_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_finalize_expired_sessions"("batch_limit_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_finalize_expired_sessions"("batch_limit_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_finalize_expired_sessions"("batch_limit_param" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_import_questions"("batch_id_param" "uuid", "file_name_param" "text", "questions_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_import_questions"("batch_id_param" "uuid", "file_name_param" "text", "questions_param" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_import_questions"("batch_id_param" "uuid", "file_name_param" "text", "questions_param" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_list_exam_templates"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_exam_templates"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_list_subjects"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_subjects"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_operational_health"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_operational_health"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_operational_health"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_reactivate_students"("user_ids_param" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reactivate_students"("user_ids_param" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_reactivate_students"("user_ids_param" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."admin_reorder_subjects"("ordered_ids_param" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reorder_subjects"("ordered_ids_param" "uuid"[]) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_save_exam_template"("template_id_param" "uuid", "name_param" "text", "description_param" "text", "duration_minutes_param" integer, "marks_correct_param" numeric, "marks_incorrect_param" numeric, "sections_param" "jsonb", "is_active_param" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_save_exam_template"("template_id_param" "uuid", "name_param" "text", "description_param" "text", "duration_minutes_param" integer, "marks_correct_param" numeric, "marks_incorrect_param" numeric, "sections_param" "jsonb", "is_active_param" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_save_subject"("subject_id_param" "uuid", "name_param" "text", "is_active_param" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_save_subject"("subject_id_param" "uuid", "name_param" "text", "is_active_param" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."admin_update_student_assignment"("student_user_id_param" "uuid", "class_name_param" "text", "section_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_student_assignment"("student_user_id_param" "uuid", "class_name_param" "text", "section_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."admin_update_student_assignment"("student_user_id_param" "uuid", "class_name_param" "text", "section_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."assert_current_student_session"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_current_student_session"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."assert_exam_payload_bounds"("questions_data_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_exam_payload_bounds"("questions_data_param" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."assert_exam_required_media"("questions_data_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_exam_required_media"("questions_data_param" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."assert_subject_name"("name_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."audit_class_admin_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_class_admin_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_exam_admin_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_exam_admin_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_provisioned_student"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_provisioned_student"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."audit_question_admin_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."audit_question_admin_change"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."block_direct_cbt_exams_raw_writes"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."block_direct_cbt_exams_raw_writes"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."build_session_response_schema"("paper_param" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."canonical_question_text"("value" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."canonical_question_text"("value" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."canonical_question_text"("value" "text") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."capture_student_result_review"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."capture_student_result_review"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_student_session"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_student_session"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_student_session"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."cleanup_unreferenced_exam_assets"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."cleanup_unreferenced_exam_assets"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_account_provisioning"("account_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_account_provisioning"("account_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_auth_session_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_auth_session_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_auth_session_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_students"("user_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_students"("user_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_user"("user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_user"("user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."exam_progress_to_submission"("progress" "jsonb", "paper_questions" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."exam_progress_to_submission"("progress" "jsonb", "paper_questions" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."exam_questions_for_viewer"("p_exam_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."exam_questions_for_viewer"("p_exam_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."exam_questions_for_viewer"("p_exam_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."finalize_expired_sessions_internal"("batch_limit_param" integer, "grace_seconds_param" integer, "actor_id_param" "uuid", "source_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."get_admin_exam_list_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "status_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_exam_list_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "status_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_exam_list_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "status_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_exam_results_export_page"("exam_id_param" "uuid", "after_student_id_param" "text", "page_size_param" integer, "expected_result_count_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_exam_results_export_page"("exam_id_param" "uuid", "after_student_id_param" "text", "page_size_param" integer, "expected_result_count_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_exam_results_export_page"("exam_id_param" "uuid", "after_student_id_param" "text", "page_size_param" integer, "expected_result_count_param" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_exam_results_page"("exam_id_param" "uuid", "page_number_param" integer, "page_size_param" integer, "search_param" "text", "expected_result_count_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_exam_results_page"("exam_id_param" "uuid", "page_number_param" integer, "page_size_param" integer, "search_param" "text", "expected_result_count_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_exam_results_page"("exam_id_param" "uuid", "page_number_param" integer, "page_size_param" integer, "search_param" "text", "expected_result_count_param" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_question_bank_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "subject_param" "text", "type_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_question_bank_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "subject_param" "text", "type_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_question_bank_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "subject_param" "text", "type_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_questions_by_ids"("question_ids_param" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_questions_by_ids"("question_ids_param" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_questions_by_ids"("question_ids_param" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_student_result_review"("result_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_student_result_review"("result_id_param" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_student_result_review"("result_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_admin_student_roster_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "class_param" "text", "section_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_admin_student_roster_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "class_param" "text", "section_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_student_roster_page"("page_number_param" integer, "page_size_param" integer, "search_param" "text", "class_param" "text", "section_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_db_size"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_db_size"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_db_size"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."get_my_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_my_role"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_student_exam_result"("exam_id_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_student_exam_result"("exam_id_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_student_exam_result"("exam_id_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_unreferenced_exam_assets"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_unreferenced_exam_assets"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_unreferenced_exam_assets"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_cbt_exams_modification"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_cbt_exams_modification"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_admin_aal2"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin_aal2"() TO "service_role";
GRANT ALL ON FUNCTION "public"."is_admin_aal2"() TO "authenticated";



REVOKE ALL ON FUNCTION "public"."is_exam_asset_referenced"("asset_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_exam_asset_referenced"("asset_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_exam_asset_referenced"("asset_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_root_developer"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_root_developer"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_root_developer"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."normalize_exam_template_sections"("sections_param" "jsonb") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."normalize_submission_response_map"("raw_responses" "jsonb", "paper_questions" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."normalize_submission_response_map"("raw_responses" "jsonb", "paper_questions" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."preflight_validate_exam"("exam_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."preflight_validate_exam"("exam_id_param" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."preflight_validate_exam"("exam_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_class_deletion"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_class_deletion"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_committed_student_results"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_committed_student_results"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_exam_deletion"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_exam_deletion"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."protect_inactive_student_assignment"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."protect_inactive_student_assignment"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."reconstruct_exam_questions"("qdata" "jsonb", "ans" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reconstruct_exam_questions"("qdata" "jsonb", "ans" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_exam_asset_cleanup"("asset_names" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_exam_asset_cleanup"("asset_names" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_exam_asset_cleanup"("asset_names" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_result_export"("exam_id_param" "uuid", "export_format_param" "text", "expected_result_count_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_result_export"("exam_id_param" "uuid", "export_format_param" "text", "expected_result_count_param" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_result_export"("exam_id_param" "uuid", "export_format_param" "text", "expected_result_count_param" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."register_managed_administrator"("account_id_param" "uuid", "creator_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."register_managed_administrator"("account_id_param" "uuid", "creator_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."release_student_session"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_student_session"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."release_student_session"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_active_subject"("subject_name_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_active_subject"("subject_name_param" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_active_subject"("subject_name_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."root_application_reset_preview"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_application_reset_preview_for_actor"("actor_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."root_application_reset_preview_for_actor"("actor_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."root_clear_exams"("confirmation_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_clear_questions"("confirmation_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_clear_results"("confirmation_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_clear_scoped_data_for_actor"("actor_id_param" "uuid", "target_param" "text", "confirmation_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."root_clear_scoped_data_for_actor"("actor_id_param" "uuid", "target_param" "text", "confirmation_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."root_count_optional_legacy_table"("table_name_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_delete_optional_legacy_table"("table_name_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_reset_application_data"("confirmation_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."root_reset_application_data_for_actor"("actor_id_param" "uuid", "confirmation_param" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."root_reset_application_data_for_actor"("actor_id_param" "uuid", "confirmation_param" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."run_scheduled_session_finalization"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."sanitize_exam_responses"("raw_responses" "jsonb", "paper_questions" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sanitize_exam_responses"("raw_responses" "jsonb", "paper_questions" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_managed_administrator_enabled"("account_id_param" "uuid", "enabled_param" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_managed_administrator_enabled"("account_id_param" "uuid", "enabled_param" boolean) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."set_session_response_schema"() FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."start_exam_session"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_exam_session"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."start_exam_session_stage3_internal"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_exam_session_stage3_internal"("exam_id_param" "uuid", "exam_data_param" "jsonb", "responses_param" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."subject_usage"("subject_name_param" "text") FROM PUBLIC;



REVOKE ALL ON FUNCTION "public"."submit_exam"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_exam"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."submit_exam_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_exam_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_active_session_progress"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_active_session_progress"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) TO "authenticated";



REVOKE ALL ON FUNCTION "public"."sync_active_session_progress_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_active_session_progress_stage3_internal"("exam_id_param" "uuid", "responses_param" "jsonb", "expected_version_param" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_exam_status_event"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_exam_status_event"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_exam_subject_time"("exam_id_param" "uuid", "subject_time_seconds_param" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_exam_subject_time"("exam_id_param" "uuid", "subject_time_seconds_param" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_exam_subject_time"("exam_id_param" "uuid", "subject_time_seconds_param" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."terminate_exam"("exam_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."terminate_exam"("exam_id_param" "uuid") TO "authenticated";



REVOKE ALL ON FUNCTION "public"."terminate_exam_stage3_internal"("exam_id_param" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."terminate_exam_stage3_internal"("exam_id_param" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_cbt_exams_raw_record"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_cbt_exams_raw_record"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_exam_required_media_record"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_exam_required_media_record"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_full_exam_paper"("p_title" "text", "p_questions_data" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_full_exam_paper"("p_title" "text", "p_questions_data" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_full_exam_paper_stage1_internal"("p_title" "text", "p_questions_data" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_full_exam_paper_stage1_internal"("p_title" "text", "p_questions_data" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_question_bank_content"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_question_bank_content"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_result_exam_reference"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_result_exam_reference"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_student_record"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_student_record"() TO "service_role";



GRANT ALL ON TABLE "public"."active_sessions" TO "service_role";
GRANT SELECT ON TABLE "public"."active_sessions" TO "authenticated";



GRANT ALL ON TABLE "public"."admin_audit_events" TO "service_role";
GRANT SELECT ON TABLE "public"."admin_audit_events" TO "authenticated";



GRANT ALL ON TABLE "public"."application_owner" TO "service_role";



GRANT ALL ON TABLE "public"."cbt_exam_answers" TO "service_role";



GRANT ALL ON TABLE "public"."cbt_exams_raw" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."cbt_exams_raw" TO "authenticated";



GRANT SELECT("title") ON TABLE "public"."cbt_exams_raw" TO "authenticated";



GRANT SELECT("status") ON TABLE "public"."cbt_exams_raw" TO "authenticated";



GRANT SELECT("class") ON TABLE "public"."cbt_exams_raw" TO "authenticated";



GRANT SELECT("section") ON TABLE "public"."cbt_exams_raw" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."cbt_exams_raw" TO "authenticated";



GRANT ALL ON TABLE "public"."cbt_exams" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."cbt_exams" TO "authenticated";



GRANT ALL ON TABLE "public"."classes" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."classes" TO "authenticated";



GRANT ALL ON TABLE "public"."exam_status_events" TO "service_role";
GRANT SELECT ON TABLE "public"."exam_status_events" TO "authenticated";



GRANT ALL ON TABLE "public"."exam_templates" TO "service_role";



GRANT ALL ON TABLE "public"."import_history" TO "service_role";
GRANT SELECT ON TABLE "public"."import_history" TO "authenticated";



GRANT ALL ON TABLE "public"."managed_administrators" TO "service_role";
GRANT SELECT ON TABLE "public"."managed_administrators" TO "authenticated";



GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."question_bank" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."question_bank" TO "authenticated";



GRANT ALL ON TABLE "public"."question_import_batches" TO "service_role";
GRANT SELECT ON TABLE "public"."question_import_batches" TO "authenticated";



GRANT ALL ON TABLE "public"."student_result_reviews" TO "service_role";



GRANT ALL ON TABLE "public"."student_results" TO "service_role";
GRANT SELECT ON TABLE "public"."student_results" TO "authenticated";



GRANT ALL ON TABLE "public"."students" TO "service_role";



GRANT SELECT("id") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("student_id") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("name") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("created_at") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("class") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("section") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("active_auth_session_id") ON TABLE "public"."students" TO "authenticated";



GRANT SELECT("archived_at") ON TABLE "public"."students" TO "authenticated";



GRANT ALL ON TABLE "public"."subjects" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT UPDATE ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLES TO "service_role";







