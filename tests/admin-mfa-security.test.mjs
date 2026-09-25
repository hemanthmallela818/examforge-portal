import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { adminSource } from './support/adminSource.mjs';
import { loadEdgeModule } from './support/edgeSource.mjs';

test('Stage 2: Comprehensive RLS Policy History Cleanup, Active-Session Boundary, and AAL2 Enforcement', async () => {
  const db = new PGlite();

  try {
    // =========================================================================
    // 1. REPRODUCE PRE-STAGE-2 SCHEMA, TABLES, STORAGE, AND LEGACY POLICIES
    // =========================================================================
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
        total_score numeric,
        max_score numeric,
        correct integer,
        incorrect integer,
        unattempted integer,
        subject_scores jsonb,
        submitted_at timestamptz DEFAULT now(),
        UNIQUE (student_id, exam_id)
      );
      ALTER TABLE student_results ENABLE ROW LEVEL SECURITY;

      CREATE TABLE question_bank (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category text DEFAULT 'Mains' NOT NULL,
        subject text NOT NULL,
        type text NOT NULL,
        question_text text NOT NULL,
        options jsonb NOT NULL DEFAULT '[]'::jsonb,
        correct_answer text NOT NULL
      );
      ALTER TABLE question_bank ENABLE ROW LEVEL SECURITY;

      CREATE TABLE import_history (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        filename text NOT NULL,
        total_rows integer NOT NULL,
        imported_by uuid,
        created_at timestamptz DEFAULT now()
      );
      ALTER TABLE import_history ENABLE ROW LEVEL SECURITY;

      CREATE TABLE storage.objects (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        bucket_id text NOT NULL,
        name text,
        owner uuid,
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now()
      );
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$;

      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT COALESCE(nullif(current_setting('request.jwt.claim.role', true), ''), 'authenticated'); $$;

      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
        $$ SELECT COALESCE(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb; $$;

      CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT COALESCE((SELECT role FROM public.profiles WHERE id = auth.uid()), 'student'); $$;

      CREATE VIEW public.cbt_exams AS
        SELECT id, title, status, questions_data, class, section, created_at
        FROM public.cbt_exams_raw;

      GRANT ALL ON ALL TABLES IN SCHEMA public, storage TO anon, authenticated, service_role;

      -- Create exact pre-Stage-2 legacy policies with AAL1 get_my_role() = 'admin' bypasses
      CREATE POLICY profiles_read_own ON public.profiles FOR SELECT TO authenticated
        USING (auth.uid() = id OR public.get_my_role() = 'admin');
      CREATE POLICY profiles_admin_all ON public.profiles FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');

      CREATE POLICY classes_read ON public.classes FOR SELECT TO authenticated
        USING (true);
      CREATE POLICY classes_admin_all ON public.classes FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');

      CREATE POLICY students_read_own ON public.students FOR SELECT TO authenticated
        USING (auth.uid() = id OR public.get_my_role() = 'admin');
      CREATE POLICY students_admin_all ON public.students FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');

      CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw FOR SELECT TO authenticated
        USING (public.get_my_role() = 'admin' OR EXISTS (
          SELECT 1 FROM public.students s WHERE s.id = auth.uid()
            AND (cbt_exams_raw.class IS NULL OR cbt_exams_raw.class = 'All' OR s.class = cbt_exams_raw.class)
            AND (cbt_exams_raw.section IS NULL OR cbt_exams_raw.section = 'All' OR s.section = cbt_exams_raw.section)
        ));

      CREATE POLICY student_results_read_own ON public.student_results FOR SELECT TO authenticated
        USING (public.get_my_role() = 'admin' OR student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid()));
      CREATE POLICY student_results_admin_all ON public.student_results FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');

      CREATE POLICY active_sessions_read_own ON public.active_sessions FOR SELECT TO authenticated
        USING (public.get_my_role() = 'admin' OR student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid()));
      CREATE POLICY active_sessions_admin_all ON public.active_sessions FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');
      CREATE POLICY active_sessions_update_progress ON public.active_sessions FOR UPDATE TO authenticated
        USING (public.get_my_role() = 'admin' OR student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid()))
        WITH CHECK (public.get_my_role() = 'admin' OR student_id = (SELECT s.student_id FROM public.students s WHERE s.id = auth.uid()));

      CREATE POLICY question_bank_admin_all ON public.question_bank FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');

      CREATE POLICY import_history_admin_all ON public.import_history FOR ALL TO authenticated
        USING (public.get_my_role() = 'admin');

      CREATE POLICY exam_assets_admin_insert ON storage.objects FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin');
      CREATE POLICY exam_assets_admin_update ON storage.objects FOR UPDATE TO authenticated
        USING (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin');
      CREATE POLICY exam_assets_admin_delete ON storage.objects FOR DELETE TO authenticated
        USING (bucket_id = 'exam-assets' AND public.get_my_role() = 'admin');

      -- Pre-Stage-2 get_db_size() with get_my_role() <> 'admin'
      CREATE OR REPLACE FUNCTION public.get_db_size()
      RETURNS TABLE(table_name text, size_bytes bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
      BEGIN
        IF public.get_my_role() <> 'admin' THEN
          RAISE EXCEPTION 'Administrator access is required';
        END IF;
        RETURN QUERY SELECT c.relname::text, pg_total_relation_size(c.oid)::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname;
      END;
      $$;
    `);

    // =========================================================================
    // 2. APPLY COMPLETE MIGRATION CHAIN: STAGE 1 & STAGE 2 MIGRATIONS
    // =========================================================================
    for (const file of [
      '20260910090000_deep_exam_data_validation.sql',
      '20260910100000_referential_integrity_and_archival.sql',
      '20260910110000_normalize_legacy_question_types.sql',
      '20260910120000_server_enforced_admin_mfa.sql',
      '20260910130000_stage2_mfa_policy_corrections.sql',
      '20260910140000_restrict_exam_asset_access.sql'
    ]) {
      const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await db.exec(sql);
    }

    // Attach handle_cbt_exams_modification trigger
    await db.exec(`
      CREATE TRIGGER handle_cbt_exams_modification_trigger
        INSTEAD OF INSERT OR UPDATE OR DELETE ON public.cbt_exams
        FOR EACH ROW EXECUTE FUNCTION public.handle_cbt_exams_modification();
    `);

    // =========================================================================
    // 3. PROVE NO POLICY EXPRESSION RETAINS AN ADMINISTRATIVE get_my_role() BYPASS
    // =========================================================================
    const policies = (await db.query(`
      SELECT schemaname, tablename, policyname, cmd, qual, with_check
      FROM pg_policies
      WHERE schemaname IN ('public', 'storage');
    `)).rows;

    const obsoletePolicies = [
      'profiles_admin_all',
      'classes_admin_all',
      'students_admin_all',
      'student_results_admin_all',
      'active_sessions_admin_all',
      'question_bank_admin_all',
      'import_history_admin_all',
      'exam_assets_admin_insert',
      'exam_assets_admin_update',
      'exam_assets_admin_delete',
    ];

    for (const p of policies) {
      assert.ok(
        !obsoletePolicies.includes(p.policyname),
        `Obsolete policy ${p.policyname} must be completely dropped`
      );

      // Verify that no administrative policy check still relies on get_my_role()
      const qualStr = String(p.qual || '');
      const withCheckStr = String(p.with_check || '');

      if (p.policyname.includes('admin') || p.policyname.includes('assigned')) {
        assert.doesNotMatch(
          qualStr,
          /get_my_role\(\)\s*=\s*'admin'/,
          `Policy ${p.policyname} qual must not use get_my_role() = 'admin'`
        );
        assert.doesNotMatch(
          withCheckStr,
          /get_my_role\(\)\s*=\s*'admin'/,
          `Policy ${p.policyname} with_check must not use get_my_role() = 'admin'`
        );
      }
    }

    // Seed test users, class, and exam
    const adminId = '10000000-0000-0000-0000-000000000001';
    const studentId = '20000000-0000-0000-0000-000000000002';
    const otherStudentId = '20000000-0000-0000-0000-000000000003';
    const examId = '30000000-0000-0000-0000-000000000003';
    const unassignedExamId = '30000000-0000-0000-0000-000000000004';

    await db.exec(`
      INSERT INTO profiles (id, email, name, role) VALUES
        ('${adminId}', 'admin@test.com', 'Test Admin', 'admin'),
        ('${studentId}', 'student@test.com', 'Test Student', 'student'),
        ('${otherStudentId}', 'other@test.com', 'Other Student', 'student');

      INSERT INTO classes (name, sections) VALUES ('Class 12', ARRAY['A', 'B']);

      INSERT INTO students (id, student_id, name, class, section) VALUES
        ('${studentId}', 'STU-001', 'Test Student', 'Class 12', 'A'),
        ('${otherStudentId}', 'STU-002', 'Other Student', 'Class 10', 'B');

      SET cbt.trusted_exam_context = 'on';
      INSERT INTO cbt_exams_raw (id, title, status, questions_data, class, section) VALUES
        ('${examId}', 'Assigned Active Exam', 'ACTIVE', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": [{"id": "q1", "type": "MCQ", "text": "Q1", "options": ["A", "B", "C", "D"], "questionImageUrl": "questions/assigned.jpg"}]}}'::jsonb, 'Class 12', 'A'),
        ('${unassignedExamId}', 'Unassigned Exam', 'ACTIVE', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": [{"id": "q1", "type": "MCQ", "text": "Q1", "options": ["A", "B", "C", "D"], "questionImageUrl": "questions/unassigned.jpg"}]}}'::jsonb, 'Class 10', 'B');

      INSERT INTO storage.objects (id, bucket_id, name) VALUES
        ('40000000-0000-0000-0000-000000000001', 'exam-assets', 'questions/assigned.jpg'),
        ('40000000-0000-0000-0000-000000000002', 'exam-assets', 'questions/unassigned.jpg'),
        ('40000000-0000-0000-0000-000000000003', 'exam-assets', 'questions/unreferenced.jpg');

      INSERT INTO cbt_exam_answers (exam_id, answers) VALUES
        ('${examId}', '{"q1": {"correct_answer": "0", "subject": "Math", "type": "MCQ"}}'::jsonb);

      INSERT INTO question_bank (category, subject, type, question_text, options, correct_answer) VALUES
        ('Mains', 'Math', 'MCQ', 'Question 1', '["A","B","C","D"]'::jsonb, '0');

      INSERT INTO active_sessions (id, student_id, exam_id, user_responses, time_left, started_at) VALUES
        ('sess-stu-001', 'STU-001', '${examId}', '{"q1": "0"}'::jsonb, 180, now()),
        ('sess-stu-002', 'STU-002', '${unassignedExamId}', '{"q1": "1"}'::jsonb, 180, now());

      INSERT INTO student_results (exam_id, student_id, student_name, total_score) VALUES
        ('${examId}', 'STU-001', 'Test Student', 20),
        ('${unassignedExamId}', 'STU-002', 'Other Student', 15);
      RESET cbt.trusted_exam_context;
    `);

    await db.exec(`SET ROLE authenticated;`);

    // =========================================================================
    // 4. PROVE AAL1 ADMINISTRATOR IS STRICTLY BLOCKED FROM ALL ADMIN OPERATIONS
    // =========================================================================
    await db.exec(`SET request.jwt.claim.role = 'authenticated'; SET request.jwt.claim.sub = '${adminId}'; SET request.jwt.claim.aal = 'aal1';`);

    // AAL1 cannot read answer keys
    const aal1Answers = (await db.query(`SELECT * FROM cbt_exam_answers WHERE exam_id = '${examId}'`)).rows;
    assert.equal(aal1Answers.length, 0, 'AAL1 admin cannot read cbt_exam_answers');

    // AAL1 cannot read question bank
    const aal1QB = (await db.query(`SELECT * FROM question_bank`)).rows;
    assert.equal(aal1QB.length, 0, 'AAL1 admin cannot read question_bank');

    // AAL1 cannot mutate classes
    await assert.rejects(
      db.query(`INSERT INTO classes (name, sections) VALUES ('Class 9', ARRAY['A'])`),
      /violates row-level security policy/,
      'AAL1 admin cannot insert into classes'
    );

    // AAL1 cannot mutate cbt_exams view
    const validUpdatePayload = JSON.stringify({
      duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ["Math"],
      questions: { Math: [{ id: "q1", type: "MCQ", text: "Q1", options: ["A", "B", "C", "D"], correctAnswer: "0", questionImageUrl: "questions/assigned.jpg" }] }
    });
    await assert.rejects(
      db.query(`UPDATE cbt_exams SET title = 'AAL1 Modified', questions_data = $1::jsonb WHERE id = '${examId}'`, [validUpdatePayload]),
      /Administrator access with MFA \(AAL2\) is required/,
      'AAL1 admin cannot update exams through view'
    );

    // AAL1 cannot call delete_students
    await assert.rejects(
      db.query(`SELECT public.delete_students(ARRAY['${studentId}']::uuid[])`),
      /Administrator access with MFA \(AAL2\) is required/,
      'AAL1 admin cannot invoke delete_students'
    );

    // AAL1 cannot call get_db_size
    await assert.rejects(
      db.query(`SELECT * FROM public.get_db_size()`),
      /Administrator access with MFA \(AAL2\) is required/,
      'AAL1 admin cannot invoke get_db_size'
    );

    // AAL1 cannot read or delete active_sessions
    const aal1Sessions = (await db.query(`SELECT * FROM active_sessions`)).rows;
    assert.equal(aal1Sessions.length, 0, 'AAL1 admin cannot select active_sessions');
    const aal1DeleteCount = (await db.query(`DELETE FROM active_sessions WHERE id = 'sess-stu-001'`)).rowCount;
    assert.equal(aal1DeleteCount, 0, 'AAL1 admin cannot delete active_sessions');

    // =========================================================================
    // 5. PROVE AAL2 ADMINISTRATOR CAN PERFORM REQUIRED ADMINISTRATIVE OPERATIONS
    // =========================================================================
    await db.exec(`SET request.jwt.claim.role = 'authenticated'; SET request.jwt.claim.sub = '${adminId}'; SET request.jwt.claim.aal = 'aal2';`);

    // AAL2 reads answers
    const aal2Answers = (await db.query(`SELECT * FROM cbt_exam_answers WHERE exam_id = '${examId}'`)).rows;
    assert.equal(aal2Answers.length, 1, 'AAL2 admin can read cbt_exam_answers');

    // AAL2 reads question bank
    const aal2QB = (await db.query(`SELECT * FROM question_bank`)).rows;
    assert.equal(aal2QB.length, 1, 'AAL2 admin can read question_bank');

    // AAL2 creates class
    await db.query(`INSERT INTO classes (name, sections) VALUES ('Class 11', ARRAY['A'])`);
    const createdClass = (await db.query(`SELECT name FROM classes WHERE name = 'Class 11'`)).rows;
    assert.equal(createdClass.length, 1, 'AAL2 admin can insert classes');

    // AAL2 updates exam view
    await db.query(`UPDATE cbt_exams SET title = 'AAL2 Verified Exam', questions_data = $1::jsonb WHERE id = '${examId}'`, [validUpdatePayload]);
    const updatedTitle = (await db.query(`SELECT title FROM cbt_exams WHERE id = '${examId}'`)).rows[0]?.title;
    assert.equal(updatedTitle, 'AAL2 Verified Exam', 'AAL2 admin can update exams through view');

    // AAL2 executes get_db_size
    const dbSizes = (await db.query(`SELECT * FROM public.get_db_size()`)).rows;
    assert.ok(dbSizes.length > 0, 'AAL2 admin can execute get_db_size');

    // AAL2 can insert and delete active_sessions
    await db.query(`INSERT INTO active_sessions (id, student_id, exam_id, time_left) VALUES ('sess-admin-created', 'STU-001', '${examId}', 100)`);
    const adminSess = (await db.query(`SELECT id FROM active_sessions WHERE id = 'sess-admin-created'`)).rows;
    assert.equal(adminSess.length, 1, 'AAL2 admin can insert into active_sessions');
    await db.query(`DELETE FROM active_sessions WHERE id = 'sess-admin-created'`);
    const adminSessDeleted = (await db.query(`SELECT id FROM active_sessions WHERE id = 'sess-admin-created'`)).rows;
    assert.equal(adminSessDeleted.length, 0, 'AAL2 admin can delete from active_sessions');

    // =========================================================================
    // 6. PROVE CANDIDATE / STUDENT RESTRICTIONS & STAGE 1 ACTIVE-SESSION BOUNDARY
    // =========================================================================
    await db.exec(`SET request.jwt.claim.role = 'authenticated'; SET request.jwt.claim.sub = '${studentId}'; SET request.jwt.claim.aal = 'aal1';`);

    // Student can read own session
    const ownSession = (await db.query(`SELECT id, student_id FROM active_sessions WHERE student_id = 'STU-001'`)).rows;
    assert.equal(ownSession.length, 1, 'Student can select own active session');
    assert.equal(ownSession[0].student_id, 'STU-001');

    // Student CANNOT read other student's session
    const otherSession = (await db.query(`SELECT id FROM active_sessions WHERE student_id = 'STU-002'`)).rows;
    assert.equal(otherSession.length, 0, 'Student cannot select other students active sessions');

    // Student CANNOT directly insert an active session (must use start_exam_session)
    await assert.rejects(
      db.query(`INSERT INTO active_sessions (id, student_id, exam_id, time_left) VALUES ('sess-direct', 'STU-001', '${examId}', 180)`),
      /violates row-level security policy/,
      'Student cannot directly insert into active_sessions'
    );

    // Student CANNOT directly delete an active session
    const stuDeleteCount = (await db.query(`DELETE FROM active_sessions WHERE student_id = 'STU-001'`)).rowCount;
    assert.equal(stuDeleteCount, 0, 'Student cannot directly delete from active_sessions');

    // Student CAN update own response progress
    await db.query(`UPDATE active_sessions SET user_responses = '{"q1": "1"}'::jsonb WHERE student_id = 'STU-001'`);
    const updatedResp = (await db.query(`SELECT user_responses FROM active_sessions WHERE student_id = 'STU-001'`)).rows[0]?.user_responses;
    assert.equal(updatedResp.q1, '1', 'Student can update own user_responses');

    // Student CANNOT update protected columns (started_at, time_left, jumbled_exam_data)
    await assert.rejects(
      db.query(`UPDATE active_sessions SET started_at = now() WHERE student_id = 'STU-001'`),
      /permission denied for (table|column)/,
      'Student cannot update started_at'
    );
    await assert.rejects(
      db.query(`UPDATE active_sessions SET time_left = 9999 WHERE student_id = 'STU-001'`),
      /permission denied for (table|column)/,
      'Student cannot update time_left'
    );

    // Student can read assigned exam, cannot read unassigned exam
    const assignedExams = (await db.query(`SELECT id FROM cbt_exams_raw WHERE id = '${examId}'`)).rows;
    assert.equal(assignedExams.length, 1, 'Student can read assigned exam');
    const unassignedExams = (await db.query(`SELECT id FROM cbt_exams_raw WHERE id = '${unassignedExamId}'`)).rows;
    assert.equal(unassignedExams.length, 0, 'Student cannot read unassigned exam');

    // Student can read own result, cannot read other result
    const ownResult = (await db.query(`SELECT total_score FROM student_results WHERE student_id = 'STU-001'`)).rows;
    assert.equal(ownResult.length, 1, 'Student can read own result');
    const otherResult = (await db.query(`SELECT total_score FROM student_results WHERE student_id = 'STU-002'`)).rows;
    assert.equal(otherResult.length, 0, 'Student cannot read other student result');

    // Student cannot directly insert into student_results
    await assert.rejects(
      db.query(`INSERT INTO student_results (exam_id, student_id, total_score) VALUES ('${examId}', 'STU-001', 100)`),
      /violates row-level security policy/,
      'Student cannot directly insert student_results'
    );

    // Student cannot read answers or question bank
    assert.equal((await db.query(`SELECT * FROM cbt_exam_answers`)).rows.length, 0, 'Student cannot read answers');
    assert.equal((await db.query(`SELECT * FROM question_bank`)).rows.length, 0, 'Student cannot read question_bank');

    const visibleAssets = (await db.query(`SELECT name FROM storage.objects ORDER BY name`)).rows.map(row => row.name);
    assert.deepEqual(visibleAssets, ['questions/assigned.jpg'], 'Student can read only assets referenced by an assigned active exam');

    // =========================================================================
    // 7. PROVE SERVICE ROLE OPERATIONS REMAIN FULLY FUNCTIONAL
    // =========================================================================
    await db.exec(`SET request.jwt.claim.role = 'service_role'; RESET request.jwt.claim.sub; RESET request.jwt.claim.aal;`);
    const serviceRoleRes = (await db.query('SELECT public.is_admin_aal2() AS allowed')).rows[0].allowed;
    assert.equal(serviceRoleRes, true, 'service_role retains is_admin_aal2 privileges');

    await db.exec(`RESET ROLE;`);
  } finally {
    await db.close();
  }
});

test('Stage 2: Edge Function Origin and Security Behavioral Contracts', async () => {
  // The function spans several modules; load the real module graph under Node.
  const edgeModule = await loadEdgeModule();
  const { isOriginAllowed, handleManageStudent } = edgeModule;

  // 1. Strict URL origin verification behavior
  assert.equal(isOriginAllowed('http://localhost.evil.com'), false, 'Must reject localhost.evil.com');
  assert.equal(isOriginAllowed('http://localhost.evil.com:3000'), false, 'Must reject localhost.evil.com with port');
  assert.equal(isOriginAllowed('https://evil.com'), false, 'Must reject external evil origin');
  assert.equal(isOriginAllowed('javascript:alert(1)'), false, 'Must reject non-http origin');
  assert.equal(isOriginAllowed('http://localhost:5173'), false, 'Must fail closed without ALLOWED_ORIGINS');
  assert.equal(isOriginAllowed('http://127.0.0.1:3000'), false, 'Must fail closed without ALLOWED_ORIGINS');

  // Explicit ALLOWED_ORIGINS configuration
  const customConfig = 'https://exam.domain.edu, https://admin.domain.edu:8443';
  assert.equal(isOriginAllowed('https://exam.domain.edu', customConfig), true, 'Must allow configured origin');
  assert.equal(isOriginAllowed('https://admin.domain.edu:8443', customConfig), true, 'Must allow configured origin with port');
  assert.equal(isOriginAllowed('https://admin.domain.edu:9000', customConfig), false, 'Must reject port mismatch');
  assert.equal(isOriginAllowed('http://localhost:5173', customConfig), false, 'Must reject localhost when production ALLOWED_ORIGINS is set');
  assert.equal(isOriginAllowed('http://localhost:5173', 'http://localhost:5173'), true, 'Local development must explicitly allow its exact origin');
  assert.equal(isOriginAllowed(null, customConfig), true, 'Allows non-browser invocation');

  // 2. Behavioral Request Execution: Disallowed origin receives HTTP 403 immediately
  const evilReq = new Request('http://localhost/manage-student', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost.evil.com',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'create' }),
  });
  const evilRes = await handleManageStudent(evilReq);
  assert.equal(evilRes.status, 403, 'Disallowed origin must be rejected with 403');
  const evilJson = await evilRes.json();
  assert.equal(evilJson.error, 'Origin not allowed');

  // 3. Behavioral Request Execution: Oversized payload receives HTTP 413
  const oversizedData = 'X'.repeat(17000);
  const oversizedReq = new Request('http://localhost/manage-student', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'create', data: oversizedData }),
  });
  const oversizedRes = await handleManageStudent(oversizedReq);
  assert.equal(oversizedRes.status, 413, 'Oversized body must receive 413');

  // 4. Behavioral Request Execution: Unauthenticated request receives HTTP 401
  const noAuthReq = new Request('http://localhost/manage-student', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'create' }),
  });
  const noAuthRes = await handleManageStudent(noAuthReq);
  assert.equal(noAuthRes.status, 401, 'Request without Authorization must receive 401');

  // 5. Behavioral Request Execution: Forged unverified token receives 401/403
  const forgedToken = 'fakeHeader.' + Buffer.from(JSON.stringify({ aal: 'aal2', role: 'admin' })).toString('base64url') + '.fakeSig';
  const forgedReq = new Request('http://localhost/manage-student', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${forgedToken}`,
    },
    body: JSON.stringify({ action: 'create' }),
  });
  const rejectedClients = {
    caller: { auth: { getUser: async () => ({ data: { user: null }, error: new Error('invalid token') }) } },
    admin: {},
  };
  const forgedRes = await handleManageStudent(forgedReq, rejectedClients);
  assert.ok(forgedRes.status === 401 || forgedRes.status === 403, 'Forged unverified token must be rejected with 401 or 403');

  const chainResult = (result) => ({
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return result; },
  });
  const verifiedClients = {
    caller: {
      auth: { getUser: async () => ({ data: { user: { id: '10000000-0000-0000-0000-000000000001' } }, error: null }) },
      rpc: async () => ({ data: true, error: null }),
    },
    admin: { from: () => chainResult({ data: { role: 'admin' }, error: null }) },
  };
  const verifiedReq = new Request('http://localhost/manage-student', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer verified-token' },
    body: JSON.stringify({ action: 'unsupported' }),
  });
  const verifiedRes = await handleManageStudent(verifiedReq, verifiedClients);
  assert.equal(verifiedRes.status, 400, 'Verified AAL2 admin must pass authentication and reach action validation');

  let assignmentRpc = null;
  const assignmentAdmin = {
    from(table) {
      if (table === 'profiles') return chainResult({ data: { role: 'admin' }, error: null });
      if (table === 'classes') return chainResult({ data: { sections: ['A', 'B'] }, error: null });
      throw new Error(`Unexpected table: ${table}`);
    },
  };
  const assignmentReq = new Request('http://localhost/manage-student', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer verified-token' },
    body: JSON.stringify({
      action: 'update-assignment',
      studentUserId: '20000000-0000-4000-8000-000000000002',
      className: 'Class 12',
      section: 'B',
    }),
  });
  const assignmentRes = await handleManageStudent(assignmentReq, {
    caller: {
      auth: verifiedClients.caller.auth,
      rpc: async (name, args) => {
        if (name === 'is_admin_aal2') return { data: true, error: null };
        assignmentRpc = { name, args };
        return { data: { id: args.student_user_id_param }, error: null };
      },
    },
    admin: assignmentAdmin,
  });
  assert.equal(assignmentRes.status, 200, 'AAL2 assignment update must succeed through the server function');
  assert.deepEqual(assignmentRpc, {
    name: 'admin_update_student_assignment',
    args: {
      student_user_id_param: '20000000-0000-4000-8000-000000000002',
      class_name_param: 'Class 12',
      section_param: 'B',
    },
  });
});

test('Root hierarchy: password login configuration and client contracts', async () => {
  const [configToml, authPortal, dashboard, rootManager] = await Promise.all([
    readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/AuthPortal.jsx', import.meta.url), 'utf8'),
    adminSource(),
    readFile(new URL('../src/components/RootAdministratorManager.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(configToml, /minimum_password_length\s*=\s*12/, 'config.toml must require minimum password length 12');
  assert.match(configToml, /secure_password_change\s*=\s*true/, 'config.toml must require secure password change');
  assert.match(configToml, /\[auth\][\s\S]*?enable_signup\s*=\s*false/, 'Global public sign-up must remain disabled');
  assert.match(configToml, /\[auth\.email\][\s\S]*?enable_signup\s*=\s*true/, 'Email/password login provider must remain enabled');
  assert.match(authPortal, /rpc\('is_admin_aal2'\)/, 'Admin login must verify server-side managed access');
  assert.doesNotMatch(authPortal, /AdminMfaModal|mfa\.(enroll|challenge)/, 'Admin login must not require MFA');
  assert.match(dashboard, /rpc\('is_root_developer'\)/, 'Dashboard must resolve root developer authority server-side');
  assert.match(rootManager, /action:\s*'create-admin'/, 'Root controls must use trusted administrator provisioning');
  assert.match(rootManager, /set_managed_administrator_enabled/, 'Root controls must support administrator access revocation');
});
