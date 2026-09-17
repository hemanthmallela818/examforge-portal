import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const stage20Migration = new URL('../supabase/migrations/20260911000000_stage20_close_question_predisclosure.sql', import.meta.url);
const hardeningMigration = new URL('../supabase/migrations/20260912094948_stage20_definer_and_grant_hardening.sql', import.meta.url);
const grantCorrectionMigration = new URL('../supabase/migrations/20260912101543_stage20_student_policy_grant_correction.sql', import.meta.url);

test('Stage 20 blocks pre-exam paper disclosure and preserves authorized exam access', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;

      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE FUNCTION public.is_admin_aal2() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('test.admin_aal2', true) = 'on'
      $$;
      CREATE FUNCTION public.reconstruct_exam_questions(qdata jsonb, ans jsonb)
      RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
        SELECT CASE WHEN ans IS NULL THEN qdata ELSE qdata || jsonb_build_object('answer_manifest', ans) END
      $$;

      CREATE TABLE public.students (
        id uuid PRIMARY KEY,
        student_id text NOT NULL UNIQUE,
        name text NOT NULL,
        class text,
        section text,
        created_at timestamptz NOT NULL DEFAULT now(),
        active_auth_session_id uuid,
        archived_at timestamptz,
        archived_by uuid,
        archive_reason text
      );
      ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
      CREATE POLICY students_read_own ON public.students
        FOR SELECT TO authenticated USING (
          (auth.uid() = id AND archived_at IS NULL) OR public.is_admin_aal2()
        );
      CREATE TABLE public.cbt_exams_raw (
        id uuid PRIMARY KEY, title text NOT NULL, status text NOT NULL,
        questions_data jsonb NOT NULL, class text, section text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.cbt_exam_answers (
        exam_id uuid PRIMARY KEY REFERENCES public.cbt_exams_raw(id), answers jsonb NOT NULL
      );
      ALTER TABLE public.cbt_exams_raw ENABLE ROW LEVEL SECURITY;
      CREATE POLICY cbt_exams_read_assigned ON public.cbt_exams_raw
        FOR SELECT TO authenticated USING (
          public.is_admin_aal2() OR EXISTS (
            SELECT 1 FROM public.students student
            WHERE student.id = auth.uid() AND student.archived_at IS NULL
              AND (cbt_exams_raw.class IS NULL OR cbt_exams_raw.class = 'All' OR student.class = cbt_exams_raw.class)
              AND (cbt_exams_raw.section IS NULL OR cbt_exams_raw.section = 'All' OR student.section = cbt_exams_raw.section)
          )
        );
      CREATE VIEW public.cbt_exams WITH (security_invoker = true) AS
        SELECT raw.id, raw.title, raw.status, raw.class, raw.section, raw.created_at,
          CASE WHEN public.is_admin_aal2()
            THEN public.reconstruct_exam_questions(raw.questions_data, answers.answers)
            ELSE raw.questions_data - 'questions' END AS questions_data
        FROM public.cbt_exams_raw raw
        LEFT JOIN public.cbt_exam_answers answers ON answers.exam_id = raw.id;

      -- Simulate the broad/default grants present on an existing project.
      GRANT SELECT ON public.cbt_exams_raw TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.cbt_exams TO anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.reconstruct_exam_questions(jsonb, jsonb) TO anon, authenticated;

      INSERT INTO public.students (id, student_id, name, class, section) VALUES
        ('10000000-0000-0000-0000-000000000001', 'STU-001', 'Assigned Student', '12', 'A');
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section) VALUES
        ('20000000-0000-0000-0000-000000000001', 'Assigned pending paper', 'PENDING',
          '{"duration":180,"subjects":["Physics"],"questions":{"Physics":[{"id":"q1","text":"Secret question"}]}}', '12', 'A'),
        ('20000000-0000-0000-0000-000000000002', 'Other class paper', 'PENDING',
          '{"duration":180,"subjects":["Physics"],"questions":{"Physics":[{"id":"q2","text":"Other secret"}]}}', '11', 'B');
      INSERT INTO public.cbt_exam_answers (exam_id, answers) VALUES
        ('20000000-0000-0000-0000-000000000001', '{"q1":{"correctAnswer":1}}'),
        ('20000000-0000-0000-0000-000000000002', '{"q2":{"correctAnswer":2}}');
    `);

    await db.exec(await readFile(stage20Migration, 'utf8'));
    await db.exec(await readFile(hardeningMigration, 'utf8'));
    await db.exec(await readFile(grantCorrectionMigration, 'utf8'));

    const configs = await db.query(`
      SELECT proname, prosecdef, proconfig
      FROM pg_proc
      WHERE oid IN (
        'public.exam_questions_for_viewer(uuid)'::regprocedure,
        'public.reconstruct_exam_questions(jsonb,jsonb)'::regprocedure
      ) ORDER BY proname
    `);
    assert.equal(configs.rows.length, 2);
    assert.ok(configs.rows.every(row => row.prosecdef === true));
    assert.ok(configs.rows.every(row => row.proconfig?.includes('search_path=""')));

    await db.exec(`
      SELECT set_config('test.admin_aal2', 'off', false);
      SELECT set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', false);
      SET ROLE authenticated;
    `);

    assert.equal((await db.query(`SELECT id FROM public.cbt_exams_raw`)).rows.length, 1);
    const ownRosterRow = await db.query(`
      SELECT id, student_id, name, class, section, created_at,
             active_auth_session_id, archived_at
      FROM public.students
    `);
    assert.equal(ownRosterRow.rows.length, 1);
    assert.equal(ownRosterRow.rows[0].student_id, 'STU-001');
    await assert.rejects(db.query(`SELECT archived_by FROM public.students`), /permission denied/);
    await assert.rejects(db.query(`SELECT archive_reason FROM public.students`), /permission denied/);
    await assert.rejects(
      db.query(`SELECT questions_data FROM public.cbt_exams_raw`),
      /permission denied/
    );
    await assert.rejects(
      db.query(`SELECT * FROM public.cbt_exams_raw`),
      /permission denied/
    );

    const studentView = await db.query(`SELECT id, questions_data FROM public.cbt_exams`);
    assert.equal(studentView.rows.length, 1);
    assert.equal(studentView.rows[0].id, '20000000-0000-0000-0000-000000000001');
    assert.equal(studentView.rows[0].questions_data.duration, 180);
    assert.equal(studentView.rows[0].questions_data.questions, undefined);

    const directManifest = await db.query(
      `SELECT public.exam_questions_for_viewer($1) AS paper`,
      ['20000000-0000-0000-0000-000000000001']
    );
    assert.equal(directManifest.rows[0].paper.questions, undefined);
    const unassignedManifest = await db.query(
      `SELECT public.exam_questions_for_viewer($1) AS paper`,
      ['20000000-0000-0000-0000-000000000002']
    );
    assert.equal(unassignedManifest.rows[0].paper, null);
    await assert.rejects(
      db.query(`SELECT public.reconstruct_exam_questions('{}', '{}')`),
      /permission denied/
    );

    await db.exec(`RESET ROLE; UPDATE public.students SET archived_at = now(); SET ROLE authenticated;`);
    assert.equal((await db.query(`SELECT id FROM public.cbt_exams`)).rows.length, 0);
    assert.equal((await db.query(
      `SELECT public.exam_questions_for_viewer($1) AS paper`,
      ['20000000-0000-0000-0000-000000000001']
    )).rows[0].paper, null);

    await db.exec(`RESET ROLE; SELECT set_config('test.admin_aal2', 'on', false); SET ROLE authenticated;`);
    const adminView = await db.query(`SELECT id, questions_data FROM public.cbt_exams ORDER BY id`);
    assert.equal(adminView.rows.length, 2);
    assert.ok(adminView.rows.every(row => row.questions_data.questions));
    assert.ok(adminView.rows.every(row => row.questions_data.answer_manifest));

    await db.exec(`RESET ROLE; SET ROLE anon;`);
    await assert.rejects(
      db.query(`SELECT public.exam_questions_for_viewer($1)`, ['20000000-0000-0000-0000-000000000001']),
      /permission denied/
    );
    await assert.rejects(db.query(`SELECT * FROM public.cbt_exams`), /permission denied/);
    await assert.rejects(db.query(`SELECT id FROM public.students`), /permission denied/);
  } finally {
    await db.close();
  }
});

test('Stage 20 migration contracts use explicit least-privilege grants', async () => {
  const [original, hardening, grantCorrection] = await Promise.all([
    readFile(stage20Migration, 'utf8'),
    readFile(hardeningMigration, 'utf8'),
    readFile(grantCorrectionMigration, 'utf8')
  ]);
  assert.match(original, /REVOKE SELECT ON public\.cbt_exams_raw FROM authenticated/);
  assert.match(original, /GRANT SELECT \(id, title, status, class, section, created_at\)/);
  assert.match(original, /CREATE OR REPLACE VIEW public\.cbt_exams WITH \(security_invoker = true\)/);
  assert.match(hardening, /ALTER FUNCTION public\.exam_questions_for_viewer\(uuid\)[\s\S]*SET search_path = ''/);
  assert.match(hardening, /FROM PUBLIC, anon/);
  assert.match(hardening, /reconstruct_exam_questions\(jsonb, jsonb\)[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(hardening, /REVOKE ALL ON TABLE public\.cbt_exams FROM PUBLIC, anon/);
  assert.match(grantCorrection, /REVOKE SELECT ON TABLE public\.students FROM PUBLIC, anon, authenticated/);
  assert.match(grantCorrection, /GRANT SELECT \([\s\S]*active_auth_session_id,[\s\S]*archived_at[\s\S]*\) ON TABLE public\.students TO authenticated/);
  assert.doesNotMatch(grantCorrection, /GRANT SELECT \([\s\S]*(archived_by|archive_reason)/);
});
