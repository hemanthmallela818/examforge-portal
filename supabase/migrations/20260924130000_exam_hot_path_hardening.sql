-- Exam hot-path hardening for large concurrent sittings (100–300 candidates).
--
-- 1. submit_exam becomes server-authoritative when the browser confirms the
--    version of its final save, and regains the Stage 22 recovery that returns
--    an already-committed result after a device takeover (lost in Stage 24).
-- 2. Expired attempts are finalized with a deadlock-safe lock order, one
--    isolated sub-transaction per attempt, by both the admin RPC and a
--    once-a-minute pg_cron job.
-- 3. Candidate requests fail fast instead of queueing behind long lock waits.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Server-authoritative submission
-- ---------------------------------------------------------------------------
DROP FUNCTION public.submit_exam(pg_catalog.uuid, pg_catalog.jsonb);

CREATE FUNCTION public.submit_exam(
  exam_id_param pg_catalog.uuid,
  responses_param pg_catalog.jsonb,
  expected_version_param pg_catalog.int4 DEFAULT NULL
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.submit_exam(pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.int4) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_exam(pg_catalog.uuid, pg_catalog.jsonb, pg_catalog.int4) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Deadlock-safe expired-attempt finalization
-- ---------------------------------------------------------------------------
-- Candidate RPCs take the per-attempt advisory lock first and the session row
-- lock second. Finalization now uses the same order and never waits: attempts
-- that are busy are skipped and picked up on the next run.
CREATE OR REPLACE FUNCTION public.finalize_expired_sessions_internal(
  batch_limit_param pg_catalog.int4,
  grace_seconds_param pg_catalog.int4,
  actor_id_param pg_catalog.uuid,
  source_param pg_catalog.text
)
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.finalize_expired_sessions_internal(pg_catalog.int4, pg_catalog.int4, pg_catalog.uuid, pg_catalog.text)
  FROM PUBLIC, anon, authenticated;

-- Administrator button: same routine, no grace period, attributed to the admin.
CREATE OR REPLACE FUNCTION public.admin_finalize_expired_sessions(batch_limit_param integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT public.is_admin_aal2() THEN
    RAISE EXCEPTION 'Administrator access is required';
  END IF;
  RETURN public.finalize_expired_sessions_internal(batch_limit_param, 0, auth.uid(), 'administrator');
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_finalize_expired_sessions(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finalize_expired_sessions(integer) TO authenticated;

-- Scheduler entry point. The two-minute grace lets a candidate's own final
-- submission arrive first; either path is idempotent.
CREATE OR REPLACE FUNCTION public.run_scheduled_session_finalization()
RETURNS pg_catalog.jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN public.finalize_expired_sessions_internal(
    200,
    120,
    '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid,
    'scheduler'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.run_scheduled_session_finalization() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Fail fast instead of queueing behind lock waits
-- ---------------------------------------------------------------------------
ALTER ROLE authenticated SET lock_timeout = '5s';

COMMIT;

-- pg_cron is created outside the transaction above so an environment without
-- the extension still receives every other change.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.schedule(
      'examforge-finalize-expired-sessions',
      '* * * * *',
      'SELECT public.run_scheduled_session_finalization()'
    );
  ELSE
    RAISE NOTICE 'pg_cron is not available; expired attempts are finalized by administrators only.';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'pg_cron could not be enabled (%); enable it in the Supabase dashboard and re-run the schedule.', SQLERRM;
END;
$cron$;
