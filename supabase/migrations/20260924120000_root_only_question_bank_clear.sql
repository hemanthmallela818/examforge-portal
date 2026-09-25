-- PRD 2.4 / 5.1: clearing the reusable question bank is a root-developer-only
-- action. The legacy RPC previously accepted any enabled managed administrator.
CREATE OR REPLACE FUNCTION public.admin_clear_question_bank(confirmation_param text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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

REVOKE ALL ON FUNCTION public.admin_clear_question_bank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_clear_question_bank(text) TO authenticated;
