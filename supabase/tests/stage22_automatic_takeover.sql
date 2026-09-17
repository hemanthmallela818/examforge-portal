BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = extensions, public, pg_catalog;
SET LOCAL session_replication_role = replica;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
VALUES
  ('22000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'active-stage22@example.invalid', now(), now()),
  ('22000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'inactive-stage22@example.invalid', now(), now());

INSERT INTO public.profiles (id, email, name, role)
VALUES
  ('22000000-0000-0000-0000-000000000001', 'active-stage22@example.invalid', 'Stage 22 Active', 'student'),
  ('22000000-0000-0000-0000-000000000002', 'inactive-stage22@example.invalid', 'Stage 22 Inactive', 'student');

INSERT INTO public.students (
  id, student_id, name, class, section, archived_at, archived_by, archive_reason
)
VALUES
  ('22000000-0000-0000-0000-000000000001', 'S22-ACTIVE', 'Stage 22 Active', 'Class A', 'Section 1', NULL, NULL, NULL),
  ('22000000-0000-0000-0000-000000000002', 'S22-INACTIVE', 'Stage 22 Inactive', 'Class A', 'Section 1', now(), '22000000-0000-0000-0000-000000000002', 'Stage 22 inactive-account test');

INSERT INTO public.student_results (
  exam_id, student_id, student_name, total_score, max_score,
  correct, incorrect, unattempted, subject_scores
)
VALUES (
  '22000000-0000-0000-0000-000000000010', 'S22-ACTIVE', 'Stage 22 Active',
  4, 4, 1, 0, 0, '{"Physics":4}'
);

SET LOCAL session_replication_role = origin;
SELECT plan(16);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1","session_id":"22000000-0000-0000-0000-000000000101"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  public.claim_student_session() ->> 'replaced_existing_session',
  'false',
  'first login claims the student without reporting a takeover'
);
SELECT is(
  public.claim_student_session() ->> 'replaced_existing_session',
  'false',
  'a duplicate tab using the same Auth session is not a takeover'
);

RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.admin_audit_events WHERE action = 'STUDENT_SESSION_TAKEOVER'),
  0::bigint,
  'initial and duplicate-tab claims are not audited as takeovers'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1","session_id":"22000000-0000-0000-0000-000000000102"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  public.claim_student_session() ->> 'replaced_existing_session',
  'true',
  'a different newest Auth session atomically takes over'
);
SELECT throws_ok(
  $$SELECT public.sync_active_session_progress('22000000-0000-0000-0000-000000000011'::uuid, '{}'::jsonb, 1)$$,
  'P0001',
  'Active session not found or already submitted',
  'the newest session passes the ownership guard and reaches the exam operation'
);

RESET ROLE;
SELECT is(
  (SELECT active_auth_session_id FROM public.students WHERE id = '22000000-0000-0000-0000-000000000001'),
  '22000000-0000-0000-0000-000000000102'::uuid,
  'the roster stores only the newest authorized Auth session'
);
SELECT is(
  (SELECT count(*) FROM public.admin_audit_events WHERE action = 'STUDENT_SESSION_TAKEOVER'),
  1::bigint,
  'exactly one takeover audit event is recorded'
);
SELECT ok(
  (SELECT metadata = '{}'::jsonb
     AND target_id = '22000000-0000-0000-0000-000000000001'
   FROM public.admin_audit_events
   WHERE action = 'STUDENT_SESSION_TAKEOVER'),
  'the takeover audit contains no token, answers, or question content'
);

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1","session_id":"22000000-0000-0000-0000-000000000101"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  public.release_student_session(),
  false,
  'the replaced device cannot release the newest device session during logout'
);
SELECT throws_ok(
  $$SELECT public.sync_active_session_progress('22000000-0000-0000-0000-000000000011'::uuid, '{}'::jsonb, 1)$$,
  'P0001',
  'This student session has been replaced or is no longer active',
  'the replaced session is rejected authoritatively'
);
SELECT throws_ok(
  $$SELECT public.submit_exam('22000000-0000-0000-0000-000000000011'::uuid, '[]'::jsonb)$$,
  'P0001',
  'This student session has been replaced or is no longer active',
  'the replaced session cannot create a new submission'
);
SELECT is(
  public.submit_exam('22000000-0000-0000-0000-000000000010'::uuid, '[]'::jsonb) ->> 'totalScore',
  '4',
  'a retry after a lost response returns the same committed immutable result'
);

RESET ROLE;
SELECT is(
  (SELECT active_auth_session_id FROM public.students WHERE id = '22000000-0000-0000-0000-000000000001'),
  '22000000-0000-0000-0000-000000000102'::uuid,
  'the replaced device logout leaves the newest session authorized'
);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000002","role":"authenticated","aal":"aal1","session_id":"22000000-0000-0000-0000-000000000103"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.claim_student_session()$$,
  'P0001',
  'This student account is inactive',
  'an inactive student cannot take over a session'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"22000000-0000-0000-0000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.claim_student_session()$$,
  'P0001',
  'A valid authenticated Supabase session is required',
  'a missing or expired Auth session identifier fails closed'
);

RESET ROLE;
SELECT ok(
  has_function_privilege('authenticated', 'public.claim_student_session()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.submit_exam(uuid,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.assert_current_student_session()', 'EXECUTE'),
  'Stage 22 preserves the explicit browser RPC allowlist'
);

SELECT * FROM finish();
ROLLBACK;
