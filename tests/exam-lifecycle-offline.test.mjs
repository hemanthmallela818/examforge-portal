import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  remainingSecondsUntil,
  saveOfflineRecoveryRecord,
  readOfflineRecoveryRecord,
  mergeOfflineResponses,
  RECOVERY_SCHEMA_VERSION
} from '../src/examLogic.js';

test('Stage 3: Comprehensive Exam Lifecycle, Offline Resilience, and Concurrency Tests', async (t) => {
  const db = new PGlite();

  // 1. Recreate pre-Stage-3 schema, roles, and functions
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS storage;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role;
      END IF;
    END;
    $$;

    GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;

    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      name text,
      role text DEFAULT 'student'
    );
    ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

    CREATE TABLE classes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text UNIQUE,
      sections text[]
    );
    ALTER TABLE classes ENABLE ROW LEVEL SECURITY;

    CREATE TABLE students (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id text UNIQUE,
      name text,
      class text,
      section text,
      session_token text
    );
    ALTER TABLE students ENABLE ROW LEVEL SECURITY;

    CREATE TABLE cbt_exams_raw (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      status text DEFAULT 'PENDING' NOT NULL,
      questions_data jsonb NOT NULL,
      class text,
      section text,
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE cbt_exams_raw ENABLE ROW LEVEL SECURITY;

    CREATE TABLE cbt_exam_answers (
      exam_id uuid PRIMARY KEY,
      answers jsonb NOT NULL
    );
    ALTER TABLE cbt_exam_answers ENABLE ROW LEVEL SECURITY;

    CREATE TABLE active_sessions (
      id text PRIMARY KEY,
      student_id text NOT NULL,
      exam_id text NOT NULL,
      user_responses jsonb,
      jumbled_exam_data jsonb,
      time_left integer,
      started_at timestamptz,
      updated_at timestamptz DEFAULT now()
    );
    ALTER TABLE active_sessions ENABLE ROW LEVEL SECURITY;

    CREATE TABLE student_results (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      exam_id text NOT NULL,
      student_id text NOT NULL,
      student_name text,
      total_score numeric DEFAULT 0,
      max_score numeric DEFAULT 0,
      correct integer DEFAULT 0,
      incorrect integer DEFAULT 0,
      unattempted integer DEFAULT 0,
      subject_scores jsonb DEFAULT '{}'::jsonb,
      submitted_at timestamptz DEFAULT now(),
      CONSTRAINT student_results_student_exam_unique UNIQUE (student_id, exam_id)
    );
    ALTER TABLE student_results ENABLE ROW LEVEL SECURITY;

    CREATE TABLE question_bank (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      category text DEFAULT 'Mains' NOT NULL,
      subject text NOT NULL,
      type text NOT NULL,
      question_text text NOT NULL,
      options jsonb NOT NULL DEFAULT '[]'::jsonb,
      correct_answer text NOT NULL,
      points integer DEFAULT 4 NOT NULL,
      neg_points integer DEFAULT -1 NOT NULL,
      question_image_url text,
      option_image_urls jsonb,
      has_image_or_diagram boolean DEFAULT false,
      created_at timestamptz DEFAULT now()
    );
    ALTER TABLE question_bank ENABLE ROW LEVEL SECURITY;

    CREATE TABLE import_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      file_name text NOT NULL,
      total_questions integer NOT NULL,
      successful_imports integer NOT NULL,
      rejected_questions integer NOT NULL,
      status text NOT NULL,
      imported_at timestamptz DEFAULT now()
    );
    ALTER TABLE import_history ENABLE ROW LEVEL SECURITY;

    CREATE TABLE storage.buckets (
      id text PRIMARY KEY,
      name text NOT NULL,
      public boolean DEFAULT false
    );
    CREATE TABLE storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bucket_id text REFERENCES storage.buckets(id),
      name text,
      owner uuid,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid,
        NULLIF(current_setting('my.test.uid', true), '')::uuid
      );
    $$;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.role', true), ''),
        NULLIF(current_setting('my.test.role', true), ''),
        'anon'
      );
    $$;

    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
        NULLIF(current_setting('my.test.jwt_claims', true), '')::jsonb,
        jsonb_build_object('role', auth.role(), 'sub', auth.uid())
      );
    $$;

    CREATE OR REPLACE FUNCTION get_my_role()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    DECLARE
      user_role text;
    BEGIN
      SELECT role INTO user_role FROM public.profiles WHERE id = auth.uid();
      RETURN COALESCE(user_role, 'student');
    END;
    $$;

    CREATE OR REPLACE FUNCTION get_my_student_id()
    RETURNS text
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
    DECLARE
      s_id text;
    BEGIN
      SELECT student_id INTO s_id FROM public.students WHERE id = auth.uid();
      RETURN s_id;
    END;
    $$;

    CREATE OR REPLACE VIEW cbt_exams AS
      SELECT id, title, status, class, section, created_at, questions_data
      FROM cbt_exams_raw;

    GRANT ALL ON ALL TABLES IN SCHEMA public, storage TO anon, authenticated, service_role;
  `);

  // Apply complete migration sequence from 090000 through the Stage 3A correction.
  for (const file of [
    '20260910090000_deep_exam_data_validation.sql',
    '20260910100000_referential_integrity_and_archival.sql',
    '20260910110000_normalize_legacy_question_types.sql',
    '20260910120000_server_enforced_admin_mfa.sql',
    '20260910130000_stage2_mfa_policy_corrections.sql',
    '20260910140000_restrict_exam_asset_access.sql',
    '20260910150000_stage3_lifecycle_offline_resilience.sql',
    '20260910160000_stage3_integrity_corrections.sql',
    '20260910170000_server_enforced_student_sessions.sql',
    '20260910180000_stage5_academic_record_retention.sql',
    '20260910190000_stage5_student_class_retention.sql',
    '20260910200000_stage5_safe_operational_cleanup.sql',
    '20260910210000_stage6_atomic_question_import.sql',
    '20260910220000_stage6_question_content_and_media_integrity.sql',
    '20260910230000_stage7_operational_health.sql',
    '20260910240000_stage7_admin_action_audit.sql',
    '20260910250000_stage8_scale_indexes.sql'
  ]) {
    const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
    await db.exec(sql);
  }

  // Attach handle_cbt_exams_modification trigger to cbt_exams view
  await db.exec(`
    DROP TRIGGER IF EXISTS handle_cbt_exams_modification_trigger ON public.cbt_exams;
    CREATE TRIGGER handle_cbt_exams_modification_trigger
      INSTEAD OF INSERT OR UPDATE OR DELETE ON public.cbt_exams
      FOR EACH ROW EXECUTE FUNCTION public.handle_cbt_exams_modification();
  `);

  // Helper context setters
  const setStudentAuth = async (studentUuid, sessionUuid = studentUuid) => {
    await db.exec(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.role', 'authenticated', false);
      SELECT set_config('request.jwt.claim.sub', '${studentUuid}', false);
      SELECT set_config('request.jwt.claim.aal', 'aal1', false);
      SELECT set_config('my.test.role', 'authenticated', false);
      SELECT set_config('my.test.uid', '${studentUuid}', false);
      SELECT set_config('request.jwt.claims', '{"role":"authenticated","aal":"aal1","sub":"${studentUuid}","session_id":"${sessionUuid}"}', false);
    `);
  };

  const setAdminAal2Auth = async (adminUuid) => {
    await db.exec(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.role', 'authenticated', false);
      SELECT set_config('request.jwt.claim.sub', '${adminUuid}', false);
      SELECT set_config('request.jwt.claim.aal', 'aal2', false);
      SELECT set_config('my.test.role', 'authenticated', false);
      SELECT set_config('my.test.uid', '${adminUuid}', false);
      SELECT set_config('request.jwt.claims', '{"role":"authenticated","aal":"aal2","sub":"${adminUuid}"}', false);
    `);
  };

  const setAdminAal1Auth = async (adminUuid) => {
    await db.exec(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.role', 'authenticated', false);
      SELECT set_config('request.jwt.claim.sub', '${adminUuid}', false);
      SELECT set_config('request.jwt.claim.aal', 'aal1', false);
      SELECT set_config('my.test.role', 'authenticated', false);
      SELECT set_config('my.test.uid', '${adminUuid}', false);
      SELECT set_config('request.jwt.claims', '{"role":"authenticated","aal":"aal1","sub":"${adminUuid}"}', false);
    `);
  };

  // Seed baseline admin, student, and class
  const adminId = 'a1111111-1111-1111-1111-111111111111';
  const student1Id = 'b2222222-2222-2222-2222-222222222222';
  const student2Id = 'c3333333-3333-3333-3333-333333333333';

  await db.exec(`
    INSERT INTO profiles (id, email, name, role) VALUES
      ('${adminId}', 'admin@test.com', 'Admin User', 'admin'),
      ('${student1Id}', 'student1@test.com', 'Student One', 'student'),
      ('${student2Id}', 'student2@test.com', 'Student Two', 'student');

    INSERT INTO classes (name, sections) VALUES ('Class 12', ARRAY['A', 'B']);

    INSERT INTO students (id, student_id, name, class, section, active_auth_session_id) VALUES
      ('${student1Id}', 'STU-101', 'Student One', 'Class 12', 'A', '${student1Id}'),
      ('${student2Id}', 'STU-102', 'Student Two', 'Class 12', 'B', '${student2Id}');
  `);

  // Seed sample valid exam paper via cbt_exams view as AAL2 admin
  await setAdminAal2Auth(adminId);
  const examId = 'e4444444-4444-4444-4444-444444444444';
  const examData = {
    duration: 60,
    marksCorrect: 4,
    marksIncorrect: -1,
    subjects: ['Physics', 'Chemistry'],
    questions: {
      Physics: [
        { id: 'p1', text: 'Velocity of light?', options: ['3e8 m/s', '3e6 m/s', '1e5 m/s', 'Zero'], correctAnswer: '0' },
        { id: 'p2', text: 'Numerical: Acceleration due to gravity in m/s2?', type: 'NUMERICAL', correctAnswer: '9.8' },
        { id: 'p3', text: 'Zero answer test: Initial velocity of body dropped from rest?', type: 'NUMERICAL', correctAnswer: '0' }
      ],
      Chemistry: [
        { id: 'c1', text: 'Atomic number of Carbon?', options: ['6', '12', '14', '8'], correctAnswer: '0' }
      ]
    }
  };

  await db.query(`
    INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
    VALUES ($1, $2, $3, $4, $5, $6);
  `, [examId, 'Physics & Chemistry Midterm', 'ACTIVE', JSON.stringify(examData), 'Class 12', 'All']);

  // ===========================================================================
  // 1. TIMER & AUTHORITATIVE CLOCK BEHAVIORAL TESTS
  // ===========================================================================
  await t.test('1. Timer: starting exam sets server started_at; resume recalculates remaining time', async () => {
    await setStudentAuth(student1Id);

    const startRes = await db.query(`
      SELECT public.start_exam_session($1::uuid, $2::jsonb, $3::jsonb) AS session;
    `, [examId, JSON.stringify(examData), JSON.stringify({})]);

    const session1 = startRes.rows[0].session;
    assert.equal(session1.time_left, 3600);
    assert.ok(session1.started_at);
    assert.equal(session1.version, 1);

    // Repeated start request returns original session without resetting started_at
    const startAgain = await db.query(`
      SELECT public.start_exam_session($1::uuid, $2::jsonb, $3::jsonb) AS session;
    `, [examId, JSON.stringify(examData), JSON.stringify({})]);

    const session2 = startAgain.rows[0].session;
    assert.equal(session2.started_at, session1.started_at);
    assert.equal(session2.jumbled_exam_data.subjects.length, 2);
  });

  await t.test('2. Timer: local browser clock skew does not alter server remaining seconds', async () => {
    // client helper remainingSecondsUntil test
    const serverEndTime = Date.now() + 1800000; // 30 minutes
    assert.equal(remainingSecondsUntil(serverEndTime, Date.now()), 1800);

    // If local clock jumps backwards (e.g. user changes system time)
    // Client deriving from absolute deadline:
    assert.equal(remainingSecondsUntil(serverEndTime, serverEndTime - 600000), 600);

    // If local clock jumps past deadline:
    assert.equal(remainingSecondsUntil(serverEndTime, serverEndTime + 5000), 0);
  });

  await t.test('3. Timer: two concurrent start requests serialize and produce exactly one session', async () => {
    await setStudentAuth(student2Id);

    // Two simultaneous start calls
    const [resA, resB] = await Promise.all([
      db.query(`SELECT public.start_exam_session($1::uuid, $2::jsonb, $3::jsonb) AS s;`, [examId, JSON.stringify(examData), '{}']),
      db.query(`SELECT public.start_exam_session($1::uuid, $2::jsonb, $3::jsonb) AS s;`, [examId, JSON.stringify(examData), '{}'])
    ]);

    assert.equal(resA.rows[0].s.started_at, resB.rows[0].s.started_at);
    
    const countRes = await db.query(`
      SELECT count(*) as cnt FROM active_sessions WHERE student_id = 'STU-102';
    `);
    assert.equal(countRes.rows[0].cnt, 1);
  });

  // ===========================================================================
  // 2. OFFLINE & RECOVERY BEHAVIORAL TESTS
  // ===========================================================================
  await t.test('4. Offline: saveOfflineRecoveryRecord and readOfflineRecoveryRecord integrity checks', async () => {
    const studentObj = { id: 'STU-101', docId: student1Id };
    const dummyResponses = { Physics: [{ selectedOption: 0, status: 'ANSWERED' }] };

    // Mock storage
    const storageMap = new Map();
    globalThis.localStorage = {
      getItem: (k) => storageMap.get(k) || null,
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k)
    };

    saveOfflineRecoveryRecord({
      student: studentObj,
      examId,
      userUuid: student1Id,
      examData,
      userResponses: dummyResponses,
      activeSubject: 'Physics',
      currentIndices: { Physics: 0 },
      version: 2,
      endTime: Date.now() + 3000000
    });

    const readBack = readOfflineRecoveryRecord({ student: studentObj, examId, userUuid: student1Id });
    assert.ok(readBack);
    assert.equal(readBack.schemaVersion, RECOVERY_SCHEMA_VERSION);
    assert.equal(readBack.userUuid, student1Id);
    assert.equal(readBack.studentId, 'STU-101');
    assert.deepEqual(readBack.userResponses, dummyResponses);

    // Corrupt JSON handling: must fail safely and return null
    storageMap.set(`cbt_recovery_v1_${student1Id}_${examId}`, 'INVALID_CORRUPTED_JSON');
    const corruptRead = readOfflineRecoveryRecord({ student: studentObj, examId, userUuid: student1Id });
    assert.equal(corruptRead, null);

    // Cross-account protection: record belonging to student 2 must be rejected for student 1
    storageMap.set(`cbt_recovery_v1_${student1Id}_${examId}`, JSON.stringify({
      schemaVersion: 1,
      userUuid: student2Id,
      studentId: 'STU-102',
      examId
    }));
    const foreignRead = readOfflineRecoveryRecord({ student: studentObj, examId, userUuid: student1Id });
    assert.equal(foreignRead, null);
  });

  await t.test('5. Offline: mergeOfflineResponses preserves numeric 0 and discards unknown questions', async () => {
    const serverExamPaper = {
      subjects: ['Physics'],
      questions: {
        Physics: [
          { id: 'p1', text: 'Q1' },
          { id: 'p2', text: 'Q2' }
        ]
      }
    };
    const serverResponses = {
      Physics: [
        { selectedOption: null, status: 'NOT_ANSWERED' },
        { selectedOption: null, status: 'NOT_VISITED' }
      ]
    };
    const localResponses = {
      Physics: [
        { selectedOption: 0, status: 'ANSWERED' }, // numeric 0 preserved
        { selectedOption: '9.8', status: 'ANSWERED' },
        { selectedOption: 'hacked', status: 'ANSWERED' } // extraneous index not in paper
      ]
    };

    const merged = mergeOfflineResponses(serverExamPaper, serverResponses, localResponses);
    assert.equal(merged.Physics.length, 2); // extraneous question discarded
    assert.equal(merged.Physics[0].selectedOption, 0); // numeric 0 maintained
    assert.equal(merged.Physics[0].status, 'ANSWERED');
    assert.equal(merged.Physics[1].selectedOption, '9.8');
  });

  await t.test('6. Autosave: sync_active_session_progress increments version and handles optimistic conflict', async () => {
    await setStudentAuth(student1Id);

    // Sync version 1 -> 2
    const sync1 = await db.query(`
      SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, $3::integer) AS res;
    `, [examId, JSON.stringify({ Physics: [{ selectedOption: '0', status: 'ANSWERED' }] }), 1]);

    assert.equal(sync1.rows[0].res.success, true);
    assert.equal(sync1.rows[0].res.version, 2);

    // Stale tab sends version 1 again -> receives conflict
    const syncConflict = await db.query(`
      SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, $3::integer) AS res;
    `, [examId, JSON.stringify({ Physics: [{ selectedOption: '0', status: 'ANSWERED' }] }), 1]);

    assert.equal(syncConflict.rows[0].res.conflict, true);
    assert.equal(syncConflict.rows[0].res.version, 2);
  });

  // ===========================================================================
  // 3. SUBMISSION & CONCURRENCY BEHAVIORAL TESTS
  // ===========================================================================
  await t.test('7. Submission: double-click submission creates exactly 1 result idempotently', async () => {
    await setStudentAuth(student1Id);

    const submissionPayload = [
      { question_id: 'p1', selected_option: '0', status: 'ANSWERED' },
      { question_id: 'p2', selected_option: '9.8', status: 'ANSWERED' },
      { question_id: 'p3', selected_option: '0', status: 'ANSWERED' }, // numeric zero answer
      { question_id: 'c1', selected_option: '0', status: 'ANSWERED' }
    ];

    // Simultaneous submit calls
    const [subA, subB] = await Promise.all([
      db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb) AS r;`, [examId, JSON.stringify(submissionPayload)]),
      db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb) AS r;`, [examId, JSON.stringify(submissionPayload)])
    ]);

    assert.equal(subA.rows[0].r.totalScore, 16); // 4 correct * 4 = 16
    assert.equal(subA.rows[0].r.correct, 4);
    assert.equal(subB.rows[0].r.totalScore, 16);

    // Active session is atomically deleted
    const sessionCheck = await db.query(`
      SELECT count(*) as cnt FROM active_sessions WHERE student_id = 'STU-101';
    `);
    assert.equal(sessionCheck.rows[0].cnt, 0);

    // Exactly 1 result row in student_results
    const resultCheck = await db.query(`
      SELECT count(*) as cnt FROM student_results WHERE student_id = 'STU-101';
    `);
    assert.equal(resultCheck.rows[0].cnt, 1);
  });

  await t.test('8. Submission: duplicate submission on already-submitted exam returns committed result', async () => {
    await setStudentAuth(student1Id);

    const duplicateRes = await db.query(`
      SELECT public.submit_exam($1::uuid, $2::jsonb) AS r;
    `, [examId, JSON.stringify([])]);

    assert.equal(duplicateRes.rows[0].r.totalScore, 16);
    assert.equal(duplicateRes.rows[0].r.maxScore, 16);
  });

  await t.test('9. Submission: starting an already submitted exam throws error', async () => {
    await setStudentAuth(student1Id);

    await assert.rejects(async () => {
      await db.query(`
        SELECT public.start_exam_session($1::uuid, $2::jsonb, $3::jsonb);
      `, [examId, JSON.stringify(examData), '{}']);
    }, /already been submitted/i);
  });

  await t.test('9A. Numerical grading rejects non-decimal input and enforces the documented tolerance boundary', async () => {
    const withinToleranceExamId = 'a1616161-1616-4161-8161-161616161616';
    const outsideToleranceExamId = 'b1616161-1616-4161-8161-161616161616';
    const numericalExamData = {
      duration: 60,
      marksCorrect: 4,
      marksIncorrect: -1,
      totalQuestions: 1,
      subjects: ['Mathematics'],
      questions: {
        Mathematics: [{ id: 'numeric-boundary', type: 'NUMERICAL', text: 'Enter the value', options: [], correctAnswer: '9.8' }]
      }
    };

    await setAdminAal2Auth(adminId);
    for (const id of [withinToleranceExamId, outsideToleranceExamId]) {
      await db.query(`
        INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
        VALUES ($1, $2, 'ACTIVE', $3, 'Class 12', 'A');
      `, [id, `Numerical boundary ${id}`, JSON.stringify(numericalExamData)]);
    }

    await setStudentAuth(student1Id);
    await db.query(`SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb);`, [withinToleranceExamId]);
    await assert.rejects(
      () => db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb);`, [withinToleranceExamId, JSON.stringify([
        { question_id: 'numeric-boundary', selected_option: '9.8e0', status: 'ANSWERED' }
      ])]),
      /Invalid numerical response/i
    );
    const within = await db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb) AS result;`, [withinToleranceExamId, JSON.stringify([
      { question_id: 'numeric-boundary', selected_option: '9.800009', status: 'ANSWERED' }
    ])]);
    assert.equal(within.rows[0].result.correct, 1);
    assert.equal(Number(within.rows[0].result.totalScore), 4);

    await db.query(`SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb);`, [outsideToleranceExamId]);
    const outside = await db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb) AS result;`, [outsideToleranceExamId, JSON.stringify([
      { question_id: 'numeric-boundary', selected_option: '9.80001', status: 'ANSWERED' }
    ])]);
    assert.equal(outside.rows[0].result.correct, 0);
    assert.equal(outside.rows[0].result.incorrect, 1);
    assert.equal(Number(outside.rows[0].result.totalScore), -1);
  });

  // ===========================================================================
  // 4. LIFECYCLE & ADMINISTRATIVE CONSTRAINTS TESTS
  // ===========================================================================
  await t.test('10. Lifecycle: cannot reactivate an ENDED exam that has student results', async () => {
    await setAdminAal2Auth(adminId);

    // End the exam
    await db.query(`
      UPDATE cbt_exams SET status = 'ENDED' WHERE id = $1;
    `, [examId]);

    // Reactivation must be rejected because student1 has a submitted result
    await assert.rejects(async () => {
      await db.query(`
        UPDATE cbt_exams SET status = 'ACTIVE' WHERE id = $1;
      `, [examId]);
    }, /Cannot reactivate an ended exam that has student attempts or results/i);
  });

  await t.test('11. Lifecycle: cannot modify questions, duration, or marks on exam with results', async () => {
    await setAdminAal2Auth(adminId);

    const modifiedExamData = {
      ...examData,
      duration: 120, // trying to alter duration after attempt begun
    };

    await assert.rejects(async () => {
      await db.query(`
        UPDATE cbt_exams SET questions_data = $1 WHERE id = $2;
      `, [JSON.stringify(modifiedExamData), examId]);
    }, /Cannot modify exam questions, duration, scoring, or assignment after student attempts have begun/i);
  });

  await t.test('12. Lifecycle: cannot delete an exam with student results', async () => {
    await setAdminAal2Auth(adminId);
    const protectedExam = await db.query(`SELECT title FROM cbt_exams WHERE id = $1;`, [examId]);

    await assert.rejects(async () => {
      await db.query(`
        SELECT public.admin_delete_unused_exam($1, $2);
      `, [examId, protectedExam.rows[0].title]);
    }, /Cannot delete an exam with submitted results/i);
  });

  // ===========================================================================
  // 5. SECURITY REGRESSION TESTS
  // ===========================================================================
  await t.test('13. Security: candidate cannot write to started_at or time_left directly', async () => {
    await setStudentAuth(student2Id);

    // Start session for student2 on another active exam
    const exam2Id = 'e5555555-5555-5555-5555-555555555555';
    await setAdminAal2Auth(adminId);
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, $2, $3, $4, $5, $6);
    `, [exam2Id, 'Chemistry Special', 'ACTIVE', JSON.stringify(examData), 'Class 12', 'All']);

    await setStudentAuth(student2Id);
    await db.query(`
      SELECT public.start_exam_session($1::uuid, $2::jsonb, $3::jsonb);
    `, [exam2Id, JSON.stringify(examData), '{}']);

    // Attempt direct UPDATE of started_at
    await assert.rejects(async () => {
      await db.query(`
        UPDATE active_sessions SET started_at = now() + interval '1 hour' WHERE student_id = 'STU-102';
      `);
    }, /permission denied/i);

    // Attempt direct UPDATE of time_left
    await assert.rejects(async () => {
      await db.query(`
        UPDATE active_sessions SET time_left = 99999 WHERE student_id = 'STU-102';
      `);
    }, /permission denied/i);

    // Attempt direct INSERT on student_results
    await assert.rejects(async () => {
      await db.query(`
        INSERT INTO student_results (exam_id, student_id, total_score) VALUES ('${exam2Id}', 'STU-102', 100);
      `);
    }, /permission denied|violates row-level security/i);

    // Attempt direct SELECT on cbt_exam_answers
    const ansRead = await db.query(`
      SELECT * FROM cbt_exam_answers WHERE exam_id = '${exam2Id}';
    `);
    assert.equal(ansRead.rows.length, 0); // RLS returns 0 rows to candidate
  });

  await t.test('14. Security: AAL1 admin cannot modify exam; AAL2 admin succeeds', async () => {
    await setAdminAal1Auth(adminId);

    // The metadata-only security-invoker view exposes no mutable row to AAL1.
    const aal1Update = await db.query(`
      UPDATE cbt_exams SET title = 'Hacked Title'
      WHERE id = 'e5555555-5555-5555-5555-555555555555';
    `);
    assert.equal(aal1Update.affectedRows, 0);

    await db.exec('RESET ROLE;');
    const unchangedTitle = await db.query(`
      SELECT title FROM cbt_exams_raw
      WHERE id = 'e5555555-5555-5555-5555-555555555555';
    `);
    assert.equal(unchangedTitle.rows[0].title, 'Chemistry Special');

    // AAL2 admin succeeds
    await setAdminAal2Auth(adminId);
    await db.query(`
      UPDATE cbt_exams SET title = 'AAL2 Approved Title' WHERE id = 'e5555555-5555-5555-5555-555555555555';
    `);

    const titleCheck = await db.query(`
      SELECT title FROM cbt_exams_raw WHERE id = 'e5555555-5555-5555-5555-555555555555';
    `);
    assert.equal(titleCheck.rows[0].title, 'AAL2 Approved Title');
  });

  const correctedExamId = 'e6666666-6666-6666-6666-666666666666';
  const terminationExamId = 'e7777777-7777-7777-7777-777777777777';

  await t.test('15. Pre-start security: candidates receive metadata but not question content', async () => {
    await setAdminAal2Auth(adminId);
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, 'Stage 3A Deadline Exam', 'ACTIVE', $2, 'Class 12', 'All');
    `, [correctedExamId, JSON.stringify(examData)]);

    await setStudentAuth(student1Id);
    const candidateExam = await db.query(`
      SELECT questions_data FROM cbt_exams WHERE id = $1;
    `, [correctedExamId]);
    assert.equal(candidateExam.rows.length, 1);
    assert.equal(candidateExam.rows[0].questions_data.questions, undefined);
    assert.equal(candidateExam.rows[0].questions_data.duration, 60);
  });

  let correctedPaper;
  let correctedProgress;

  await t.test('16. RPC-only progress: direct response/version writes fail and exact versions are required', async () => {
    await setStudentAuth(student1Id);
    const started = await db.query(`
      SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{"Physics": [{"selectedOption": 3, "status": "ANSWERED"}]}'::jsonb) AS session;
    `, [correctedExamId]);
    correctedPaper = started.rows[0].session.jumbled_exam_data;
    correctedProgress = structuredClone(started.rows[0].session.user_responses);

    // Client-supplied answers at session creation are ignored.
    for (const subject of correctedPaper.subjects) {
      for (const response of correctedProgress[subject]) {
        assert.equal(response.selectedOption, null);
      }
    }

    await assert.rejects(async () => {
      await db.query(`UPDATE active_sessions SET version = 999999 WHERE exam_id = $1;`, [correctedExamId]);
    }, /permission denied/i);
    await assert.rejects(async () => {
      await db.query(`UPDATE active_sessions SET user_responses = '{}'::jsonb WHERE exam_id = $1;`, [correctedExamId]);
    }, /permission denied/i);

    // Save exactly one known-correct answer using the randomized server paper.
    for (const [subject, questions] of Object.entries(correctedPaper.questions)) {
      const index = questions.findIndex((question) => question.id === 'p1');
      if (index >= 0) correctedProgress[subject][index] = { selectedOption: 0, status: 'ANSWERED' };
    }
    const saved = await db.query(`
      SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1) AS result;
    `, [correctedExamId, JSON.stringify(correctedProgress)]);
    assert.equal(saved.rows[0].result.success, true);
    assert.equal(saved.rows[0].result.version, 2);

    const future = await db.query(`
      SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 999999) AS result;
    `, [correctedExamId, JSON.stringify(correctedProgress)]);
    assert.equal(future.rows[0].result.conflict, true);
    assert.equal(future.rows[0].result.version, 2);

    await assert.rejects(async () => {
      await db.query(`SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, NULL);`,
        [correctedExamId, JSON.stringify(correctedProgress)]);
    }, /positive expected session version/i);
    await assert.rejects(async () => {
      await db.query(`SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, -1);`,
        [correctedExamId, JSON.stringify(correctedProgress)]);
    }, /positive expected session version/i);
  });

  await t.test('17. Resume is read-only and cannot overwrite newer server progress', async () => {
    await setStudentAuth(student1Id);
    const stale = structuredClone(correctedProgress);
    for (const subject of Object.keys(stale)) {
      stale[subject] = stale[subject].map(() => ({ selectedOption: null, status: 'NOT_VISITED' }));
    }
    const resumed = await db.query(`
      SELECT public.start_exam_session($1::uuid, '{}'::jsonb, $2::jsonb) AS session;
    `, [correctedExamId, JSON.stringify(stale)]);
    assert.equal(resumed.rows[0].session.version, 2);
    assert.deepEqual(resumed.rows[0].session.user_responses, correctedProgress);
  });

  await t.test('18. Deadline is strict: late autosave fails and grace cannot change the graded snapshot', async () => {
    await db.exec('RESET ROLE;');
    await db.query(`
      UPDATE active_sessions
      SET deadline_at = clock_timestamp() - interval '1 second'
      WHERE exam_id = $1;
    `, [correctedExamId]);

    await setStudentAuth(student1Id);
    const changedLateProgress = structuredClone(correctedProgress);
    for (const [subject, questions] of Object.entries(correctedPaper.questions)) {
      questions.forEach((question, index) => {
        changedLateProgress[subject][index] = {
          selectedOption: question.type === 'NUMERICAL' ? '999' : 1,
          status: 'ANSWERED'
        };
      });
    }
    await assert.rejects(async () => {
      await db.query(`SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 2);`,
        [correctedExamId, JSON.stringify(changedLateProgress)]);
    }, /time has expired/i);

    const lateTamperedSubmission = [
      { question_id: 'p1', selected_option: 1, status: 'ANSWERED' },
      { question_id: 'p2', selected_option: '999', status: 'ANSWERED' },
      { question_id: 'p3', selected_option: '999', status: 'ANSWERED' },
      { question_id: 'c1', selected_option: 1, status: 'ANSWERED' }
    ];
    const finalized = await db.query(`
      SELECT public.submit_exam($1::uuid, $2::jsonb) AS result;
    `, [correctedExamId, JSON.stringify(lateTamperedSubmission)]);
    assert.equal(finalized.rows[0].result.totalScore, 4);
    assert.equal(finalized.rows[0].result.correct, 1);
    assert.equal(finalized.rows[0].result.unattempted, 3);

    const retry = await db.query(`SELECT public.submit_exam($1::uuid, '[]'::jsonb) AS result;`, [correctedExamId]);
    assert.deepEqual(retry.rows[0].result, finalized.rows[0].result);
  });

  await t.test('19. Submission validation rejects duplicate, unknown, and invalid answers', async () => {
    await setAdminAal2Auth(adminId);
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, 'Stage 3A Termination Exam', 'ACTIVE', $2, 'Class 12', 'All');
    `, [terminationExamId, JSON.stringify(examData)]);
    await setStudentAuth(student1Id);
    const started = await db.query(`SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb) AS session;`, [terminationExamId]);
    const paper = started.rows[0].session.jumbled_exam_data;

    await assert.rejects(async () => {
      await db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb);`, [terminationExamId, JSON.stringify([
        { question_id: 'p1', selected_option: 0, status: 'ANSWERED' },
        { question_id: 'p1', selected_option: 0, status: 'ANSWERED' }
      ])]);
    }, /duplicate question ID/i);
    await assert.rejects(async () => {
      await db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb);`, [terminationExamId, JSON.stringify([
        { question_id: 'unknown', selected_option: 0, status: 'ANSWERED' }
      ])]);
    }, /unknown question ID/i);
    await assert.rejects(async () => {
      await db.query(`SELECT public.submit_exam($1::uuid, $2::jsonb);`, [terminationExamId, JSON.stringify([
        { question_id: 'p1', selected_option: 99, status: 'ANSWERED' }
      ])]);
    }, /out of range/i);

    const progress = structuredClone(started.rows[0].session.user_responses);
    for (const [subject, questions] of Object.entries(paper.questions)) {
      const index = questions.findIndex((question) => question.id === 'p1');
      if (index >= 0) progress[subject][index] = { selectedOption: 0, status: 'ANSWERED' };
    }
    await db.query(`SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1);`,
      [terminationExamId, JSON.stringify(progress)]);

    // A candidate cannot select a zero result by directly invoking termination.
    await db.query(`SELECT public.terminate_exam($1::uuid);`, [terminationExamId]);
    const result = await db.query(`SELECT total_score, correct FROM student_results WHERE exam_id = $1;`, [terminationExamId]);
    assert.equal(Number(result.rows[0].total_score), 4);
    assert.equal(result.rows[0].correct, 1);
  });

  await t.test('20. Lifecycle cannot be bypassed through ENDED to PENDING and all exam data is frozen', async () => {
    await setAdminAal2Auth(adminId);
    await db.query(`UPDATE cbt_exams SET status = 'ENDED' WHERE id = $1;`, [correctedExamId]);
    await assert.rejects(async () => {
      await db.query(`UPDATE cbt_exams SET status = 'PENDING' WHERE id = $1;`, [correctedExamId]);
    }, /cannot reactivate an ended exam/i);

    const alteredMetadata = { ...examData, totalQuestions: 999 };
    await assert.rejects(async () => {
      await db.query(`UPDATE cbt_exams SET questions_data = $2 WHERE id = $1;`,
        [correctedExamId, JSON.stringify(alteredMetadata)]);
    }, /cannot modify exam questions, duration, scoring, or assignment/i);

    await db.exec('RESET ROLE;');
    const state = await db.query(`SELECT status FROM cbt_exams_raw WHERE id = $1;`, [correctedExamId]);
    assert.equal(state.rows[0].status, 'ENDED');
  });

  await t.test('21. Student takeover: only the claimed signed auth session can use exam RPCs', async () => {
    const takeoverExamId = 'e8888888-8888-8888-8888-888888888888';
    const replacementSessionId = 'f9999999-9999-4999-8999-999999999999';

    await setAdminAal2Auth(adminId);
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, 'Session Takeover Exam', 'ACTIVE', $2, 'Class 12', 'All');
    `, [takeoverExamId, JSON.stringify(examData)]);

    // Original signed session owns the student and creates the attempt.
    await setStudentAuth(student2Id);
    const originalStart = await db.query(`
      SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb) AS session;
    `, [takeoverExamId]);
    assert.equal(originalStart.rows[0].session.version, 1);

    // A new signed session is not trusted until it explicitly claims takeover.
    await setStudentAuth(student2Id, replacementSessionId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb);`, [takeoverExamId]);
    }, /session has been replaced or is no longer active/i);

    const claim = await db.query(`SELECT public.claim_student_session() AS claim;`);
    assert.equal(claim.rows[0].claim.session_id, replacementSessionId);

    // The old device loses RPC and full active-session read access immediately.
    await setStudentAuth(student2Id);
    assert.equal((await db.query(`SELECT * FROM active_sessions WHERE exam_id = $1;`, [takeoverExamId])).rows.length, 0);
    for (const operation of [
      () => db.query(`SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb);`, [takeoverExamId]),
      () => db.query(`SELECT public.sync_active_session_progress($1::uuid, '{}'::jsonb, 1);`, [takeoverExamId]),
      () => db.query(`SELECT public.submit_exam($1::uuid, '[]'::jsonb);`, [takeoverExamId]),
      () => db.query(`SELECT public.terminate_exam($1::uuid);`, [takeoverExamId])
    ]) {
      await assert.rejects(operation, /session has been replaced or is no longer active/i);
    }

    // Private implementation functions cannot be called around the wrapper.
    await assert.rejects(async () => {
      await db.query(`SELECT public.submit_exam_stage3_internal($1::uuid, '[]'::jsonb);`, [takeoverExamId]);
    }, /permission denied/i);

    // The replacement session resumes the same attempt without resetting time.
    await setStudentAuth(student2Id, replacementSessionId);
    const replacementResume = await db.query(`
      SELECT public.start_exam_session($1::uuid, '{}'::jsonb, '{}'::jsonb) AS session;
    `, [takeoverExamId]);
    assert.equal(replacementResume.rows[0].session.started_at, originalStart.rows[0].session.started_at);
    assert.equal(replacementResume.rows[0].session.version, 1);

    const released = await db.query(`SELECT public.release_student_session() AS released;`);
    assert.equal(released.rows[0].released, true);
    await assert.rejects(async () => {
      await db.query(`SELECT public.sync_active_session_progress($1::uuid, '{}'::jsonb, 1);`, [takeoverExamId]);
    }, /session has been replaced or is no longer active/i);

    // Reclaim so later cleanup/finalization remains possible.
    await db.query(`SELECT public.claim_student_session();`);
  });

  await t.test('22. Session claim rejects missing claims and direct token-column mutation', async () => {
    await db.exec(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.role', 'authenticated', false);
      SELECT set_config('request.jwt.claim.sub', '${student2Id}', false);
      SELECT set_config('request.jwt.claims', '{"role":"authenticated","aal":"aal1","sub":"${student2Id}"}', false);
    `);
    await assert.rejects(async () => {
      await db.query(`SELECT public.claim_student_session();`);
    }, /valid authenticated Supabase session/i);

    await setStudentAuth(student2Id, 'f9999999-9999-4999-8999-999999999999');
    await assert.rejects(async () => {
      await db.query(`
        UPDATE students SET active_auth_session_id = '${student2Id}' WHERE id = '${student2Id}';
      `);
    }, /permission denied/i);

    await db.exec('RESET ROLE;');
    const authoritative = await db.query(`
      SELECT active_auth_session_id FROM students WHERE id = '${student2Id}';
    `);
    assert.equal(authoritative.rows[0].active_auth_session_id, 'f9999999-9999-4999-8999-999999999999');
    const legacyColumn = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'students' AND column_name = 'session_token';
    `);
    assert.equal(legacyColumn.rows.length, 0);
  });

  await t.test('23. Academic records are immutable and unused exam deletion is atomic and audited', async () => {
    const unusedExamId = 'a4444444-4444-4444-8444-444444444444';
    const unusedTitle = 'Unused Deletion Test';

    await setAdminAal2Auth(adminId);
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, $2, 'PENDING', $3, 'Class 12', 'All');
    `, [unusedExamId, unusedTitle, JSON.stringify(examData)]);

    await assert.rejects(async () => {
      await db.query(`DELETE FROM cbt_exams WHERE id = $1;`, [unusedExamId]);
    }, /permission denied/i);

    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_delete_unused_exam($1, 'Wrong title');`, [unusedExamId]);
    }, /title confirmation did not match/i);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT * FROM admin_audit_events WHERE target_id = $1 AND action = 'DELETE_UNUSED_EXAM';`, [unusedExamId])).rows.length, 0);
    assert.equal((await db.query(`SELECT * FROM cbt_exams_raw WHERE id = $1;`, [unusedExamId])).rows.length, 1);

    await setAdminAal1Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_delete_unused_exam($1, $2);`, [unusedExamId, unusedTitle]);
    }, /AAL2/i);

    await setAdminAal2Auth(adminId);
    const deleted = await db.query(`SELECT public.admin_delete_unused_exam($1, $2) AS outcome;`, [unusedExamId, unusedTitle]);
    assert.equal(deleted.rows[0].outcome.deleted, true);

    await assert.rejects(async () => {
      await db.query(`DELETE FROM student_results WHERE exam_id = $1;`, [correctedExamId]);
    }, /permission denied|immutable/i);

    await assert.rejects(async () => {
      const existing = await db.query(`SELECT title FROM cbt_exams_raw WHERE id = $1;`, [correctedExamId]);
      await db.query(`SELECT public.admin_delete_unused_exam($1, $2);`, [correctedExamId, existing.rows[0].title]);
    }, /submitted results|student attempts/i);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT * FROM cbt_exams_raw WHERE id = $1;`, [unusedExamId])).rows.length, 0);
    assert.equal((await db.query(`SELECT * FROM cbt_exam_answers WHERE exam_id = $1;`, [unusedExamId])).rows.length, 0);
    const audit = await db.query(`SELECT * FROM admin_audit_events WHERE target_id = $1 AND action = 'DELETE_UNUSED_EXAM';`, [unusedExamId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'DELETE_UNUSED_EXAM');
    assert.equal(audit.rows[0].actor_user_id, adminId);
  });

  await t.test('24. Student deactivation is reversible, atomic, access-blocking, and preserves results', async () => {
    const missingStudentId = 'd5555555-5555-4555-8555-555555555555';
    const resultCountBefore = await db.query(`SELECT count(*)::integer AS count FROM student_results WHERE student_id = 'STU-101';`);
    assert.ok(resultCountBefore.rows[0].count > 0);

    await setAdminAal2Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_deactivate_students($1::uuid[], 'Bulk atomicity check');`, [[student1Id, missingStudentId]]);
    }, /not found/i);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT archived_at FROM students WHERE id = $1;`, [student1Id])).rows[0].archived_at, null);
    assert.equal((await db.query(`SELECT * FROM admin_audit_events WHERE target_id = $1 AND action = 'DEACTIVATE_STUDENT';`, [student1Id])).rows.length, 0);

    // A student with a live attempt cannot be deactivated mid-exam.
    await setAdminAal2Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_deactivate_students($1::uuid[], 'Attempt still active');`, [[student2Id]]);
    }, /active examination attempt/i);

    const outcome = await db.query(`SELECT public.admin_deactivate_students($1::uuid[], 'Student left institution') AS outcome;`, [[student1Id]]);
    assert.equal(outcome.rows[0].outcome.deactivated, 1);

    await db.exec('RESET ROLE;');
    const archived = await db.query(`SELECT archived_at, archived_by, archive_reason, active_auth_session_id FROM students WHERE id = $1;`, [student1Id]);
    assert.ok(archived.rows[0].archived_at);
    assert.equal(archived.rows[0].archived_by, adminId);
    assert.equal(archived.rows[0].archive_reason, 'Student left institution');
    assert.equal(archived.rows[0].active_auth_session_id, null);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM student_results WHERE student_id = 'STU-101';`)).rows[0].count, resultCountBefore.rows[0].count);

    await assert.rejects(async () => {
      await db.query(`UPDATE students SET section = 'B' WHERE id = $1;`, [student1Id]);
    }, /Inactive student assignments cannot be changed/i);

    await setStudentAuth(student1Id);
    await assert.rejects(async () => {
      await db.query(`SELECT public.claim_student_session();`);
    }, /account is inactive/i);
    assert.equal((await db.query(`SELECT * FROM students WHERE id = $1;`, [student1Id])).rows.length, 0);
    assert.equal((await db.query(`SELECT * FROM classes;`)).rows.length, 0);
    assert.equal((await db.query(`SELECT * FROM cbt_exams_raw;`)).rows.length, 0);
    assert.equal((await db.query(`SELECT * FROM student_results WHERE student_id = 'STU-101';`)).rows.length, 0);
    assert.equal((await db.query(`SELECT * FROM admin_audit_events;`)).rows.length, 0);

    await setAdminAal2Auth(adminId);
    const restored = await db.query(`SELECT public.admin_reactivate_students($1::uuid[]) AS outcome;`, [[student1Id]]);
    assert.equal(restored.rows[0].outcome.reactivated, 1);
    await setStudentAuth(student1Id);
    assert.equal((await db.query(`SELECT public.claim_student_session() AS claim;`)).rows[0].claim.student_id, 'STU-101');
  });

  await t.test('25. Class deletion requires AAL2, exact identity, no references, and creates an audit event', async () => {
    const emptyClassId = 'f6666666-6666-4666-8666-666666666666';
    await setAdminAal2Auth(adminId);
    await db.query(`INSERT INTO classes (id, name, sections) VALUES ($1, 'Empty Class', ARRAY['A']);`, [emptyClassId]);

    await assert.rejects(async () => {
      await db.query(`DELETE FROM classes WHERE id = $1;`, [emptyClassId]);
    }, /permission denied/i);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_delete_empty_class($1, 'Wrong Class');`, [emptyClassId]);
    }, /name confirmation did not match/i);

    const class12 = await db.query(`SELECT id, name FROM classes WHERE name = 'Class 12';`);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_delete_empty_class($1, $2);`, [class12.rows[0].id, class12.rows[0].name]);
    }, /student records|examination/i);

    await setAdminAal1Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_delete_empty_class($1, 'Empty Class');`, [emptyClassId]);
    }, /AAL2/i);

    await setAdminAal2Auth(adminId);
    const deleted = await db.query(`SELECT public.admin_delete_empty_class($1, 'Empty Class') AS outcome;`, [emptyClassId]);
    assert.equal(deleted.rows[0].outcome.deleted, true);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT * FROM classes WHERE id = $1;`, [emptyClassId])).rows.length, 0);
    const audit = await db.query(`SELECT * FROM admin_audit_events WHERE target_id = $1 AND action = 'DELETE_EMPTY_CLASS';`, [emptyClassId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, adminId);
  });

  await t.test('26. Expired-session maintenance grades saved work and never deletes live attempts', async () => {
    const takeoverExamId = 'e8888888-8888-8888-8888-888888888888';
    await db.exec(`
      UPDATE active_sessions
      SET deadline_at = clock_timestamp() - interval '1 minute'
      WHERE student_id = 'STU-102' AND exam_id = '${takeoverExamId}';
    `);

    await setStudentAuth(student2Id, 'f9999999-9999-4999-8999-999999999999');
    await assert.rejects(async () => {
      await db.query(`DELETE FROM active_sessions WHERE exam_id = $1;`, [takeoverExamId]);
    }, /permission denied/i);

    await setAdminAal1Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_finalize_expired_sessions(100);`);
    }, /AAL2/i);

    await setAdminAal2Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_finalize_expired_sessions(0);`);
    }, /between 1 and 500/i);
    const finalized = await db.query(`SELECT public.admin_finalize_expired_sessions(100) AS outcome;`);
    assert.equal(finalized.rows[0].outcome.finalized, 1);
    assert.equal((await db.query(`SELECT public.admin_finalize_expired_sessions(100) AS outcome;`)).rows[0].outcome.finalized, 0);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT * FROM active_sessions WHERE exam_id = $1;`, [takeoverExamId])).rows.length, 0);
    const result = await db.query(`SELECT * FROM student_results WHERE student_id = 'STU-102' AND exam_id = $1;`, [takeoverExamId]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].unattempted, 4);
    const audit = await db.query(`SELECT * FROM admin_audit_events WHERE action = 'FINALIZE_EXPIRED_SESSION' AND metadata->>'exam_id' = $1;`, [takeoverExamId]);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_user_id, adminId);
  });

  await t.test('27. Question cleanup is atomic and audited while import history is retained', async () => {
    const question1 = 'a7777777-7777-4777-8777-777777777777';
    const question2 = 'b8888888-8888-4888-8888-888888888888';
    await db.exec('RESET ROLE;');
    await db.query(`
      INSERT INTO question_bank (id, subject, type, question_text, options, correct_answer)
      VALUES ($1, 'Physics', 'MCQ', 'Question one', '["A","B","C","D"]', '0'),
             ($2, 'Chemistry', 'NUMERICAL', 'Question two', '[]', '2');
    `, [question1, question2]);
    await db.query(`
      INSERT INTO import_history (file_name, total_questions, successful_imports, rejected_questions, status)
      VALUES ('questions.json', 2, 2, 0, 'Success');
    `);

    await setAdminAal2Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`DELETE FROM question_bank WHERE id = $1;`, [question1]);
    }, /permission denied/i);
    await assert.rejects(async () => {
      await db.query(`DELETE FROM import_history;`);
    }, /permission denied/i);

    await setAdminAal1Auth(adminId);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_delete_question($1);`, [question1]);
    }, /AAL2/i);

    await setAdminAal2Auth(adminId);
    const single = await db.query(`SELECT public.admin_delete_question($1) AS outcome;`, [question1]);
    assert.equal(single.rows[0].outcome.deleted, true);
    await assert.rejects(async () => {
      await db.query(`SELECT public.admin_clear_question_bank('clear question bank');`);
    }, /Exact question-bank confirmation/i);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM question_bank;`)).rows[0].count, 1);

    const cleared = await db.query(`SELECT public.admin_clear_question_bank('CLEAR QUESTION BANK') AS outcome;`);
    assert.equal(cleared.rows[0].outcome.deleted, 1);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM question_bank;`)).rows[0].count, 0);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM import_history;`)).rows[0].count, 1);
    assert.equal((await db.query(`SELECT * FROM admin_audit_events WHERE action = 'DELETE_QUESTION' AND target_id = $1;`, [question1])).rows.length, 1);
    const clearAudit = await db.query(`SELECT * FROM admin_audit_events WHERE action = 'CLEAR_QUESTION_BANK';`);
    assert.equal(clearAudit.rows.length, 1);
    assert.equal(clearAudit.rows[0].metadata.deleted_count, 1);
    assert.equal(clearAudit.rows[0].metadata.asset_disposition, 'retained_for_exam_snapshot_safety');
  });

  await t.test('28. Question import is AAL2-only, atomic, duplicate-safe and idempotent', async () => {
    const batchId = 'c9999999-9999-4999-8999-999999999999';
    const questions = JSON.stringify([
      {
        subject: 'Physics', type: 'MCQ', question_text: 'Atomic import question one',
        options: ['A', 'B', 'C', 'D'], correct_answer: '1', has_image_or_diagram: false,
        category: 'Mains', points: 4, neg_points: -1
      },
      {
        subject: 'Mathematics', type: 'NUMERICAL', question_text: 'Atomic import question two',
        options: [], correct_answer: '0', has_image_or_diagram: false,
        category: 'Mains', points: 4, neg_points: -1
      }
    ]);

    await setAdminAal1Auth(adminId);
    await assert.rejects(() => db.query(
      `SELECT public.admin_import_questions($1, 'atomic.json', $2::jsonb);`, [batchId, questions]
    ), /AAL2/i);

    await setAdminAal2Auth(adminId);
    const first = await db.query(
      `SELECT public.admin_import_questions($1, 'atomic.json', $2::jsonb) AS outcome;`, [batchId, questions]
    );
    assert.equal(first.rows[0].outcome.imported, 2);
    assert.equal(first.rows[0].outcome.idempotent, false);
    const replay = await db.query(
      `SELECT public.admin_import_questions($1, 'atomic.json', $2::jsonb) AS outcome;`, [batchId, questions]
    );
    assert.equal(replay.rows[0].outcome.idempotent, true);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM question_bank;`)).rows[0].count, 2);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM import_history WHERE file_name = 'atomic.json';`)).rows[0].count, 1);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM admin_audit_events WHERE action = 'IMPORT_QUESTIONS';`)).rows[0].count, 1);

    await setAdminAal2Auth(adminId);
    const badBatch = 'd0000000-0000-4000-8000-000000000000';
    const invalidPayload = JSON.stringify([
      {
        subject: 'Chemistry', type: 'NUMERICAL', question_text: 'Would otherwise insert',
        options: [], correct_answer: '2', has_image_or_diagram: false,
        category: 'Mains', points: 4, neg_points: -1
      },
      {
        subject: 'Biology', type: 'MCQ', question_text: 'Invalid subject stops transaction',
        options: ['A', 'B', 'C', 'D'], correct_answer: '0', has_image_or_diagram: false,
        category: 'Mains', points: 4, neg_points: -1
      }
    ]);
    await assert.rejects(() => db.query(
      `SELECT public.admin_import_questions($1, 'invalid.json', $2::jsonb);`, [badBatch, invalidPayload]
    ), /Invalid question subject/);
    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM question_bank WHERE question_text = 'Would otherwise insert';`)).rows[0].count, 0);

    await setAdminAal2Auth(adminId);
    const duplicateBatch = 'e1111111-1111-4111-8111-111111111111';
    const duplicatePayload = questions.replace('Atomic import question two', '  ＡＴＯＭＩＣ   import question one  ');
    await assert.rejects(() => db.query(
      `SELECT public.admin_import_questions($1, 'duplicate.json', $2::jsonb);`, [duplicateBatch, duplicatePayload]
    ), /matching question already exists/i);
  });

  await t.test('29. Manual question content and required exam media are enforced by PostgreSQL', async () => {
    await db.exec('RESET ROLE;');
    await assert.rejects(() => db.query(`
      INSERT INTO question_bank (subject, type, question_text, options, correct_answer)
      VALUES ('Biology', 'MCQ', 'Invalid subject', '["A","B","C","D"]', '0');
    `), /subject must be Physics/i);
    await assert.rejects(() => db.query(`
      INSERT INTO question_bank (subject, type, question_text, options, correct_answer)
      VALUES ('Chemistry', 'MCQ', 'Missing option', '["A","B","C",""]', '0');
    `), /option requires text or an image/i);

    await db.query(`
      INSERT INTO question_bank (subject, type, question_text, question_image_url, options, correct_answer)
      VALUES ('Physics', 'MCQ', '', 'questions/11111111-1111-4111-8111-111111111111.jpg', '["A","B","C","D"]', '2'),
             ('Physics', 'MCQ', '', 'questions/22222222-2222-4222-8222-222222222222.jpg', '["A","B","C","D"]', '1');
    `);

    const missingMedia = JSON.stringify({
      questions: { Physics: [{ id: 'needs-image', text: 'Diagram question', hasImageOrDiagram: true }] }
    });
    await assert.rejects(
      () => db.query(`SELECT public.assert_exam_required_media($1::jsonb);`, [missingMedia]),
      /marked as requiring an image/i
    );
    const completeMedia = JSON.stringify({
      questions: { Physics: [{ id: 'has-image', text: 'Diagram question', hasImageOrDiagram: true, questionImageUrl: 'questions/diagram.jpg' }] }
    });
    await db.query(`SELECT public.assert_exam_required_media($1::jsonb);`, [completeMedia]);
  });

  await t.test('30. Operational health is read-only, AAL2-only, and reports actionable counts without student data', async () => {
    await db.exec('RESET ROLE;');
    await db.query(`
      INSERT INTO question_bank (subject, type, question_text, options, correct_answer, has_image_or_diagram)
      VALUES ('Chemistry', 'NUMERICAL', 'Incomplete diagram staging question', '[]', '1', true);
    `);

    await setAdminAal1Auth(adminId);
    await assert.rejects(() => db.query(`SELECT public.admin_operational_health();`), /AAL2/i);

    await setAdminAal2Auth(adminId);
    const health = (await db.query(`SELECT public.admin_operational_health() AS health;`)).rows[0].health;
    assert.equal(health.status, 'ATTENTION');
    assert.equal(health.questions_missing_required_media, 1);
    assert.ok(Number.isInteger(health.active_exams));
    assert.ok(Number.isInteger(health.live_sessions));
    assert.ok(health.checked_at);
    assert.equal('student_id' in health, false);
    assert.equal('responses' in health, false);
  });

  await t.test('31. Exam, question, class, and student-assignment administration is audited without answer content', async () => {
    await setAdminAal2Auth(adminId);
    const questionId = 'f2222222-2222-4222-8222-222222222222';
    await db.query(`
      INSERT INTO question_bank (id, subject, type, question_text, options, correct_answer)
      VALUES ($1, 'Mathematics', 'MCQ', 'Audited manual question', '["A","B","C","D"]', '3');
    `, [questionId]);
    await db.query(`INSERT INTO classes (name, sections) VALUES ('Audited Class', ARRAY['X']);`);
    await db.query(`SELECT public.admin_update_student_assignment($1, 'Audited Class', 'X');`, [student1Id]);

    await db.exec('RESET ROLE;');
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM admin_audit_events WHERE action = 'CREATE_EXAM';`)).rows[0].count >= 1, true);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM admin_audit_events WHERE action = 'CREATE_QUESTION' AND target_id = $1;`, [questionId])).rows[0].count, 1);
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM admin_audit_events WHERE action = 'CREATE_CLASS' AND metadata->>'name' = 'Audited Class';`)).rows[0].count, 1);
    const assignmentAudit = await db.query(`SELECT metadata FROM admin_audit_events WHERE action = 'UPDATE_STUDENT_ASSIGNMENT' AND target_id = $1;`, [student1Id]);
    assert.equal(assignmentAudit.rows.length, 1);
    assert.equal(assignmentAudit.rows[0].metadata.class, 'Audited Class');
    assert.equal('user_responses' in assignmentAudit.rows[0].metadata, false);
  });

  await t.test('32. Production list, maintenance, and audit queries have supporting indexes', async () => {
    await db.exec('RESET ROLE;');
    const expected = [
      'student_results_exam_student_idx',
      'active_sessions_deadline_idx',
      'cbt_exams_created_id_idx',
      'cbt_exams_active_idx',
      'question_bank_created_id_idx',
      'question_bank_missing_required_media_idx',
      'students_archived_idx',
      'admin_audit_events_occurred_idx'
    ];
    const indexes = await db.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1::text[]);
    `, [expected]);
    assert.deepEqual(indexes.rows.map(row => row.indexname).sort(), [...expected].sort());
  });
});
