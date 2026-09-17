-- Stage 7C: fill administrator audit gaps without storing secrets or answer content.

CREATE OR REPLACE FUNCTION public.audit_exam_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
REVOKE ALL ON FUNCTION public.audit_exam_admin_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_exam_admin_change_trigger ON public.cbt_exams_raw;
CREATE TRIGGER audit_exam_admin_change_trigger
  AFTER INSERT OR UPDATE ON public.cbt_exams_raw
  FOR EACH ROW EXECUTE FUNCTION public.audit_exam_admin_change();

CREATE OR REPLACE FUNCTION public.audit_question_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
REVOKE ALL ON FUNCTION public.audit_question_admin_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_question_admin_change_trigger ON public.question_bank;
CREATE TRIGGER audit_question_admin_change_trigger
  AFTER INSERT OR UPDATE ON public.question_bank
  FOR EACH ROW EXECUTE FUNCTION public.audit_question_admin_change();

CREATE OR REPLACE FUNCTION public.audit_class_admin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_aal2() THEN RETURN NEW; END IF;
  INSERT INTO public.admin_audit_events (actor_user_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), CASE WHEN TG_OP = 'INSERT' THEN 'CREATE_CLASS' ELSE 'UPDATE_CLASS' END,
          'class', NEW.id::text, jsonb_build_object('name', NEW.name, 'sections', NEW.sections));
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_class_admin_change() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_class_admin_change_trigger ON public.classes;
CREATE TRIGGER audit_class_admin_change_trigger
  AFTER INSERT OR UPDATE ON public.classes
  FOR EACH ROW EXECUTE FUNCTION public.audit_class_admin_change();

CREATE OR REPLACE FUNCTION public.admin_update_student_assignment(
  student_user_id_param uuid,
  class_name_param text,
  section_param text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
REVOKE ALL ON FUNCTION public.admin_update_student_assignment(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_student_assignment(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.audit_provisioned_student()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
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
$$;
REVOKE ALL ON FUNCTION public.audit_provisioned_student() FROM PUBLIC;
DROP TRIGGER IF EXISTS audit_provisioned_student_trigger ON public.students;
CREATE TRIGGER audit_provisioned_student_trigger
  AFTER INSERT ON public.students
  FOR EACH ROW EXECUTE FUNCTION public.audit_provisioned_student();
