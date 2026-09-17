import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL(
  '../supabase/migrations/20260912155957_stage22_atomic_student_session_takeover.sql',
  import.meta.url
);

const USER_ID = '10000000-0000-0000-0000-000000000001';
const INACTIVE_USER_ID = '10000000-0000-0000-0000-000000000002';
const SESSION_ONE = '20000000-0000-0000-0000-000000000001';
const SESSION_TWO = '20000000-0000-0000-0000-000000000002';
const EXAM_WITH_RESULT = '30000000-0000-0000-0000-000000000001';
const EXAM_WITHOUT_RESULT = '30000000-0000-0000-0000-000000000002';

async function setClaims(db, userId, sessionId) {
  await db.query(
    `SELECT set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: userId, role: 'authenticated', aal: 'aal1', session_id: sessionId })]
  );
}

test('Stage 22 atomically takes over a student session without disclosing the replaced identifier', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;

      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
      $$;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid
      $$;

      CREATE TABLE public.students (
        id uuid PRIMARY KEY,
        student_id text NOT NULL UNIQUE,
        name text NOT NULL,
        class text,
        section text,
        active_auth_session_id uuid,
        archived_at timestamptz
      );
      CREATE TABLE public.student_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        exam_id text NOT NULL,
        student_id text NOT NULL,
        student_name text NOT NULL,
        total_score numeric NOT NULL,
        max_score numeric NOT NULL,
        correct integer NOT NULL,
        incorrect integer NOT NULL,
        unattempted integer NOT NULL,
        subject_scores jsonb NOT NULL,
        submitted_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (student_id, exam_id)
      );
      CREATE TABLE public.admin_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id uuid NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );

      CREATE FUNCTION public.current_auth_session_id()
      RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
        SELECT NULLIF(auth.jwt() ->> 'session_id', '')::uuid
      $$;

      CREATE FUNCTION public.submit_exam_stage3_internal(uuid, jsonb)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
      BEGIN
        RETURN jsonb_build_object('internal', true);
      END;
      $$;

      INSERT INTO public.students (id, student_id, name, class, section, archived_at)
      VALUES
        ('${USER_ID}', 'STAGE22-1', 'Active Student', '12', 'A', NULL),
        ('${INACTIVE_USER_ID}', 'STAGE22-2', 'Inactive Student', '12', 'A', now());

      INSERT INTO public.student_results (
        exam_id, student_id, student_name, total_score, max_score,
        correct, incorrect, unattempted, subject_scores
      ) VALUES (
        '${EXAM_WITH_RESULT}', 'STAGE22-1', 'Active Student', 4, 4,
        1, 0, 0, '{"Physics":4}'
      );
    `);

    await db.exec(await readFile(migrationUrl, 'utf8'));

    await setClaims(db, USER_ID, SESSION_ONE);
    const first = (await db.query(`SELECT public.claim_student_session() AS claim`)).rows[0].claim;
    assert.equal(first.session_id, SESSION_ONE);
    assert.equal(first.replaced_existing_session, false);
    assert.deepEqual(Object.keys(first).sort(), [
      'class', 'name', 'replaced_existing_session', 'section', 'session_id', 'student_id'
    ]);

    const duplicateTab = (await db.query(`SELECT public.claim_student_session() AS claim`)).rows[0].claim;
    assert.equal(duplicateTab.replaced_existing_session, false);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM public.admin_audit_events`)).rows[0].count, 0);

    await setClaims(db, USER_ID, SESSION_TWO);
    const takeover = (await db.query(`SELECT public.claim_student_session() AS claim`)).rows[0].claim;
    assert.equal(takeover.session_id, SESSION_TWO);
    assert.equal(takeover.replaced_existing_session, true);
    assert.equal(JSON.stringify(takeover).includes(SESSION_ONE), false);
    assert.equal(
      (await db.query(`SELECT active_auth_session_id FROM public.students WHERE id = $1`, [USER_ID])).rows[0].active_auth_session_id,
      SESSION_TWO
    );

    const audit = (await db.query(`
      SELECT actor_user_id, action, target_type, target_id, metadata
      FROM public.admin_audit_events
    `)).rows[0];
    assert.equal(audit.action, 'STUDENT_SESSION_TAKEOVER');
    assert.equal(audit.actor_user_id, USER_ID);
    assert.equal(audit.target_id, USER_ID);
    assert.deepEqual(audit.metadata, {});
    assert.equal(JSON.stringify(audit).includes(SESSION_ONE), false);
    assert.equal(JSON.stringify(audit).includes(SESSION_TWO), false);

    await setClaims(db, USER_ID, SESSION_ONE);
    await assert.rejects(
      db.query(`SELECT public.assert_current_student_session()`),
      /replaced or is no longer active/i
    );
    await assert.rejects(
      db.query(`SELECT public.submit_exam($1, '[]'::jsonb)`, [EXAM_WITHOUT_RESULT]),
      /replaced or is no longer active/i
    );

    const recovered = (await db.query(
      `SELECT public.submit_exam($1, '[]'::jsonb) AS result`,
      [EXAM_WITH_RESULT]
    )).rows[0].result;
    assert.deepEqual(recovered, {
      totalScore: 4,
      maxScore: 4,
      correct: 1,
      incorrect: 0,
      unattempted: 0,
      subjectScores: { Physics: 4 }
    });

    await setClaims(db, USER_ID, SESSION_TWO);
    await db.query(`SELECT public.assert_current_student_session()`);

    await setClaims(db, INACTIVE_USER_ID, SESSION_ONE);
    await assert.rejects(
      db.query(`SELECT public.claim_student_session()`),
      /account is inactive/i
    );

    await db.query(
      `SELECT set_config('request.jwt.claims', $1, false)`,
      [JSON.stringify({ sub: USER_ID, role: 'authenticated', aal: 'aal1' })]
    );
    await assert.rejects(
      db.query(`SELECT public.claim_student_session()`),
      /valid authenticated Supabase session is required/i
    );
  } finally {
    await db.close();
  }
});

test('Stage 22 browser and database contracts preserve recovery and lock rejected devices', async () => {
  const [migration, app, authPortal, examAuthority] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/AuthPortal.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260912103740_stage21_exam_authority_function_hardening.sql', import.meta.url), 'utf8')
  ]);

  const returnBlock = migration.slice(migration.indexOf('RETURN pg_catalog.jsonb_build_object'));
  assert.match(returnBlock, /'replaced_existing_session', replaced_existing_session/);
  assert.doesNotMatch(returnBlock, /'previous_session_id'|'replaced_session_id'|'old_session_id'/);
  assert.match(migration, /STUDENT_SESSION_TAKEOVER/);
  assert.match(migration, /'\{\}'::pg_catalog\.jsonb/);
  assert.match(migration, /student-session-claim/g);
  assert.match(examAuthority, /public\.assert_current_student_session\(\)/g);

  assert.match(authPortal, /sessionClaim\.replaced_existing_session === true/);
  assert.match(authPortal, /latest answers already confirmed by the exam server/i);
  assert.match(authPortal, /Answers saved only on the other device cannot be recovered here/i);
  assert.match(app, /studentSessionLockedRef\.current = true/);
  assert.match(app, /handleSafeLogout\(\{ preserveAttempt: true \}\)/);
  assert.match(app, /disabled=\{isExamLocked \|\| studentSessionLocked\}/);
  assert.doesNotMatch(
    app.slice(app.indexOf('// Session hijacking listener'), app.indexOf('// Bounded, deterministic autosave engine')),
    /handleSafeLogout\(\);/
  );
});
