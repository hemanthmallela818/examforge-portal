import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Stage 1: server-side deep exam validation, raw-table bypass closure, image-option handling, and failure-safe diagnostic', async () => {
  const db = new PGlite();

  try {
    // Base schema tables
    await db.exec(`
      CREATE TABLE profiles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text,
        name text,
        role text DEFAULT 'student'
      );
      ALTER TABLE profiles ADD CONSTRAINT profiles_role_valid CHECK (role IN ('student', 'admin')) NOT VALID;

      CREATE TABLE classes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, sections text[]);
      ALTER TABLE classes ADD CONSTRAINT classes_data_valid CHECK (
        length(btrim(name)) BETWEEN 1 AND 120
        AND cardinality(sections) > 0
        AND array_position(sections, '') IS NULL
      ) NOT VALID;

      CREATE TABLE students (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id text UNIQUE, name text, class text, section text);
      CREATE TABLE cbt_exams_raw (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        status text DEFAULT 'PENDING' NOT NULL,
        questions_data jsonb NOT NULL,
        class text,
        section text,
        created_at timestamptz DEFAULT now()
      );
      ALTER TABLE cbt_exams_raw ADD CONSTRAINT cbt_exams_status_valid CHECK (status IN ('PENDING', 'ACTIVE', 'ENDED')) NOT VALID;
      ALTER TABLE cbt_exams_raw ADD CONSTRAINT cbt_exams_data_valid CHECK (
        length(btrim(title)) BETWEEN 1 AND 200
        AND jsonb_typeof(questions_data) = 'object'
        AND jsonb_typeof(questions_data->'subjects') = 'array'
        AND jsonb_array_length(questions_data->'subjects') > 0
        AND jsonb_typeof(questions_data->'questions') = 'object'
        AND COALESCE(questions_data->>'duration', '') ~ '^[0-9]+$'
        AND (questions_data->>'duration')::integer BETWEEN 1 AND 600
        AND COALESCE(questions_data->>'marksCorrect', '') ~ '^[+]?[0-9]+([.][0-9]+)?$'
        AND (questions_data->>'marksCorrect')::numeric BETWEEN 0 AND 100
        AND COALESCE(questions_data->>'marksIncorrect', '') ~ '^-?[0-9]+([.][0-9]+)?$'
        AND (questions_data->>'marksIncorrect')::numeric BETWEEN -100 AND 0
      ) NOT VALID;

      CREATE TABLE cbt_exam_answers (exam_id uuid PRIMARY KEY, answers jsonb NOT NULL);
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
      CREATE TABLE question_bank (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category text DEFAULT 'Mains' NOT NULL,
        subject text NOT NULL,
        type text NOT NULL,
        question_text text NOT NULL,
        question_image_url text,
        options jsonb NOT NULL DEFAULT '[]'::jsonb,
        option_image_urls jsonb,
        correct_answer text NOT NULL
      );
      ALTER TABLE question_bank ADD CONSTRAINT question_bank_data_valid CHECK (
        type IN ('MCQ', 'NUMERICAL', 'NAT')
        AND length(btrim(subject)) BETWEEN 1 AND 120
        AND (
          (type = 'MCQ' AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4 AND correct_answer IN ('0', '1', '2', '3'))
          OR
          (type IN ('NUMERICAL', 'NAT') AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 0
            AND correct_answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$')
        )
      ) NOT VALID;

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated;
        END IF;
      END;
      $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated;

      CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text LANGUAGE plpgsql STABLE AS
        $$ BEGIN RETURN COALESCE(nullif(current_setting('request.jwt.claim.role', true), ''), 'admin'); END; $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE plpgsql STABLE AS
        $$ BEGIN RETURN COALESCE(nullif(current_setting('request.jwt.claim.subrole', true), ''), 'authenticated'); END; $$;

      CREATE VIEW public.cbt_exams AS
        SELECT id, title, status, questions_data, class, section, created_at
        FROM public.cbt_exams_raw;
    `);

    // Load Stage 1 migrations in order
    for (const file of [
      '20260910090000_deep_exam_data_validation.sql',
      '20260910100000_referential_integrity_and_archival.sql'
    ]) {
      const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await db.exec(sql);
    }

    // Attach handle_cbt_exams_modification trigger to cbt_exams view
    await db.exec(`
      CREATE TRIGGER handle_cbt_exams_modification_trigger
        INSTEAD OF INSERT OR UPDATE OR DELETE ON public.cbt_exams
        FOR EACH ROW EXECUTE FUNCTION public.handle_cbt_exams_modification();
    `);

    // =========================================================================
    // 1. REAL ROLE PERMISSIONS & DIRECT RAW-TABLE MUTATION REJECTION
    // =========================================================================
    // Verify migration's conditional revoke statements ran by switching to authenticated role
    await db.exec(`SET ROLE authenticated;`);

    // Authenticated role direct writes on cbt_exams_raw fail due to REVOKE permissions
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams_raw (title, questions_data) VALUES ('Bypass Exam', '{"duration": 180}')`),
      /permission denied for table cbt_exams_raw/
    );
    await assert.rejects(
      db.query(`UPDATE cbt_exams_raw SET title = 'Bypass Update'`),
      /permission denied for table cbt_exams_raw/
    );
    await assert.rejects(
      db.query(`DELETE FROM cbt_exams_raw`),
      /permission denied for table cbt_exams_raw/
    );

    // Authenticated role direct writes on cbt_exam_answers fail due to REVOKE permissions
    await assert.rejects(
      db.query(`INSERT INTO cbt_exam_answers (exam_id, answers) VALUES ('00000000-0000-0000-0000-000000000001', '{}'::jsonb)`),
      /permission denied for table cbt_exam_answers/
    );
    await assert.rejects(
      db.query(`UPDATE cbt_exam_answers SET answers = '{}'::jsonb`),
      /permission denied for table cbt_exam_answers/
    );
    await assert.rejects(
      db.query(`DELETE FROM cbt_exam_answers`),
      /permission denied for table cbt_exam_answers/
    );

    // Authenticated student cannot modify through the protected view
    await db.exec(`SET request.jwt.claim.role = 'student';`);
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Student Exam', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": [{"id": "s1", "type": "MCQ", "text": "Q", "options": ["1","2","3","4"], "correctAnswer": 0}]}}')`),
      /Only administrators can modify exams/
    );

    // Authenticated administrator CAN modify an exam through the protected view
    await db.exec(`SET request.jwt.claim.role = 'admin';`);
    const permAdminExamId = '00000000-0000-0000-0000-000000000088';
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, 'Admin Auth Exam', 'ACTIVE', $2, 'Class 12', 'A')
    `, [permAdminExamId, JSON.stringify({
      duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
      questions: { Math: [{ id: 's1', type: 'MCQ', text: 'Q', options: ['1','2','3','4'], correctAnswer: 0 }] }
    })]);
    const adminCreated = (await db.query('SELECT title FROM cbt_exams WHERE id = $1', [permAdminExamId])).rows[0];
    assert.equal(adminCreated.title, 'Admin Auth Exam');

    // Restore owner role
    await db.exec(`RESET ROLE;`);

    // Table owner (postgres) direct mutations are blocked by statement triggers when trusted context is off
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams_raw (title, questions_data) VALUES ('Bypass Exam', '{"duration": 180}')`),
      /Direct modification of table cbt_exams_raw is prohibited/
    );
    await assert.rejects(
      db.query(`UPDATE cbt_exams_raw SET title = 'Bypass Update'`),
      /Direct modification of table cbt_exams_raw is prohibited/
    );
    await assert.rejects(
      db.query(`DELETE FROM cbt_exams_raw WHERE id = '${permAdminExamId}'`),
      /Direct modification of table cbt_exams_raw is prohibited/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exam_answers (exam_id, answers) VALUES ('00000000-0000-0000-0000-000000000001', '{}'::jsonb)`),
      /Direct modification of table cbt_exam_answers is prohibited/
    );
    await assert.rejects(
      db.query(`UPDATE cbt_exam_answers SET answers = '{}'::jsonb WHERE exam_id = '${permAdminExamId}'`),
      /Direct modification of table cbt_exam_answers is prohibited/
    );
    await assert.rejects(
      db.query(`DELETE FROM cbt_exam_answers WHERE exam_id = '${permAdminExamId}'`),
      /Direct modification of table cbt_exam_answers is prohibited/
    );

    // =========================================================================
    // 2. EXAM CONFIGURATION INTEGRITY VALIDATION
    // =========================================================================
    // Status constraint rejects ARCHIVED under current schema (only PENDING, ACTIVE, ENDED allowed)
    await assert.rejects(
      db.query(`
        INSERT INTO cbt_exams (title, status, questions_data)
        VALUES ('Archived Exam', 'ARCHIVED', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": [{"id": "a1", "type": "MCQ", "text": "Q", "options": ["1","2","3","4"], "correctAnswer": 0}]}}')
      `),
      /cbt_exams_status_valid/
    );

    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '"invalid_json"')`),
      /questions_data must be a valid JSON object/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 0, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": []}}')`),
      /duration must be between 1 and 600 minutes/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 1000, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": []}}')`),
      /duration must be between 1 and 600 minutes/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 180, "marksCorrect": 150, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": []}}')`),
      /marksCorrect must be between 0 and 100/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": 2, "subjects": ["Math"], "questions": {"Math": []}}')`),
      /marksIncorrect must be between -100 and 0/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math", "math"], "questions": {"Math": [], "math": []}}')`),
      /duplicate subject/i
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": [], "Physics": []}}')`),
      /undeclared subject "Physics"/
    );
    await assert.rejects(
      db.query(`INSERT INTO cbt_exams (title, questions_data) VALUES ('Test Exam', '{"duration": 180, "marksCorrect": 4, "marksIncorrect": -1, "subjects": ["Math"], "questions": {"Math": []}}')`),
      /must contain at least one question/
    );

    // Duplicate question IDs across subjects rejected
    const dupQuestionExam = {
      duration: 180,
      marksCorrect: 4,
      marksIncorrect: -1,
      subjects: ['Math', 'Physics'],
      questions: {
        Math: [{ id: 'duplicate-q-id', type: 'MCQ', text: 'Math Q', options: ['A', 'B', 'C', 'D'], correctAnswer: 0 }],
        Physics: [{ id: 'duplicate-q-id', type: 'MCQ', text: 'Physics Q', options: ['A', 'B', 'C', 'D'], correctAnswer: 1 }]
      }
    };
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', ['Dup Test', JSON.stringify(dupQuestionExam)]),
      /duplicate question id "duplicate-q-id"/
    );

    // =========================================================================
    // 3. MCQ OPTION & IMAGE VALIDATION
    // =========================================================================
    // Rejection: MCQ with 3 options instead of 4
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Bad Options',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: { Math: [{ id: 'q1', type: 'MCQ', text: 'P', options: ['1', '2', '3'], correctAnswer: 0 }] }
        })
      ]),
      /must have exactly 4 options/
    );

    // Rejection: MCQ option missing both text and image
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Missing Option',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: {
            Math: [{
              id: 'q_empty_opt', type: 'MCQ', text: 'Prompt',
              options: ['Option 1', '', 'Option 3', 'Option 4'],
              optionImageUrls: [null, null, null, null],
              correctAnswer: 0
            }]
          }
        })
      ]),
      /missing both text and image/
    );

    // Rejection: MCQ duplicate text-only options (case-insensitive)
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Dup Text Opt',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: { Math: [{ id: 'q1', type: 'MCQ', text: 'P', options: ['Alpha', 'Beta', 'alpha', 'Gamma'], correctAnswer: 0 }] }
        })
      ]),
      /contains duplicate options/
    );

    // Rejection: MCQ duplicate image-only options
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Dup Img Opt',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: {
            Math: [{
              id: 'q_dup_img', type: 'MCQ', text: 'Prompt',
              options: ['', '', '', ''],
              optionImageUrls: ['path/diagram.png', 'path/diagram.png', 'path/alt1.png', 'path/alt2.png'],
              correctAnswer: 0
            }]
          }
        })
      ]),
      /contains duplicate options/
    );

    // Acceptance: Valid Image-Only MCQ with 4 distinct images and empty text options
    const validImageOnlyExamId = '00000000-0000-0000-0000-000000000010';
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data)
      VALUES ($1, 'Image MCQ Exam', 'ACTIVE', $2)
    `, [
      validImageOnlyExamId,
      JSON.stringify({
        duration: 90, marksCorrect: 4, marksIncorrect: -1, subjects: ['Biology'],
        questions: {
          Biology: [{
            id: 'bio_img_q1', type: 'MCQ', text: 'Identify the specimen:',
            options: ['', '', '', ''],
            optionImageUrls: ['storage/specimen_a.png', 'storage/specimen_b.png', 'storage/specimen_c.png', 'storage/specimen_d.png'],
            correctAnswer: 'C'
          }]
        }
      })
    ]);

    const imageExamRaw = (await db.query('SELECT * FROM cbt_exams_raw WHERE id = $1', [validImageOnlyExamId])).rows[0];
    assert.equal(imageExamRaw.title, 'Image MCQ Exam');
    // Ensure optionImageUrls was retained
    assert.deepEqual(imageExamRaw.questions_data.questions.Biology[0].optionImageUrls, [
      'storage/specimen_a.png', 'storage/specimen_b.png', 'storage/specimen_c.png', 'storage/specimen_d.png'
    ]);
    // Ensure correctAnswer was stripped from raw table
    assert.equal(imageExamRaw.questions_data.questions.Biology[0].correctAnswer, undefined);

    // Acceptance: Valid Mixed Text and Image Options
    const mixedExamId = '00000000-0000-0000-0000-000000000020';
    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data)
      VALUES ($1, 'Mixed Options Exam', 'ACTIVE', $2)
    `, [
      mixedExamId,
      JSON.stringify({
        duration: 90, marksCorrect: 4, marksIncorrect: -1, subjects: ['Chemistry'],
        questions: {
          Chemistry: [{
            id: 'chem_mixed_q1', type: 'MCQ', text: 'Select correct molecule:',
            options: ['Benzene', 'Phenol', '', ''],
            optionImageUrls: [null, null, 'storage/toluene.png', 'storage/aniline.png'],
            correctAnswer: 1
          }]
        }
      })
    ]);
    const mixedRaw = (await db.query('SELECT * FROM cbt_exams_raw WHERE id = $1', [mixedExamId])).rows[0];
    assert.equal(mixedRaw.title, 'Mixed Options Exam');

    // Rejection: Invalid correct answer index for MCQ
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Bad Ans',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: { Math: [{ id: 'q1', type: 'MCQ', text: 'P', options: ['A', 'B', 'C', 'D'], correctAnswer: 4 }] }
        })
      ]),
      /invalid correct answer/
    );

    // =========================================================================
    // 4. NUMERICAL QUESTIONS VALIDATION
    // =========================================================================
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Bad Num Options',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: { Math: [{ id: 'num1', type: 'NUMERICAL', text: 'P', options: ['1'], correctAnswer: '5' }] }
        })
      ]),
      /must not have multiple-choice options/
    );
    await assert.rejects(
      db.query('INSERT INTO cbt_exams (title, questions_data) VALUES ($1, $2)', [
        'Bad Num Ans',
        JSON.stringify({
          duration: 180, marksCorrect: 4, marksIncorrect: -1, subjects: ['Math'],
          questions: { Math: [{ id: 'num1', type: 'NUMERICAL', text: 'P', options: [], correctAnswer: 'nan' }] }
        })
      ]),
      /invalid non-numeric answer/
    );

    // =========================================================================
    // 5. VALID COMPLETE EXAM INSERTION & UPDATE VIA PROTECTED VIEW
    // =========================================================================
    const validExamId = '00000000-0000-0000-0000-000000000099';
    const validExam = {
      duration: 180,
      marksCorrect: 4,
      marksIncorrect: -1,
      subjects: ['Physics', 'Mathematics'],
      questions: {
        Physics: [
          { id: 'p1', type: 'MCQ', text: 'Physics Q1', options: ['Opt A', 'Opt B', 'Opt C', 'Opt D'], correctAnswer: 'B' }
        ],
        Mathematics: [
          { id: 'm1', type: 'NUMERICAL', text: 'Math Q1', options: [], correctAnswer: '-3.1415' }
        ]
      }
    };

    await db.query(`
      INSERT INTO cbt_exams (id, title, status, questions_data, class, section)
      VALUES ($1, 'Valid JEE Mock', 'ACTIVE', $2, 'Class 12', 'A')
    `, [validExamId, JSON.stringify(validExam)]);

    // Check answers separated atomically
    const rawExam = (await db.query('SELECT * FROM cbt_exams_raw WHERE id = $1', [validExamId])).rows[0];
    assert.equal(rawExam.title, 'Valid JEE Mock');
    assert.equal(rawExam.questions_data.questions.Physics[0].correctAnswer, undefined);
    assert.equal(rawExam.questions_data.questions.Mathematics[0].correctAnswer, undefined);

    const answerRow = (await db.query('SELECT * FROM cbt_exam_answers WHERE exam_id = $1', [validExamId])).rows[0];
    assert.deepEqual(answerRow.answers, {
      p1: { correct_answer: '1', subject: 'Physics', type: 'MCQ' },
      m1: { correct_answer: '-3.1415', subject: 'Mathematics', type: 'NUMERICAL' }
    });

    // Update through protected view revalidates and synchronizes answers
    const updatedExam = {
      ...validExam,
      questions: {
        ...validExam.questions,
        Physics: [
          { id: 'p1', type: 'MCQ', text: 'Updated Physics Q1', options: ['Opt A', 'Opt B', 'Opt C', 'Opt D'], correctAnswer: 'D' }
        ]
      }
    };
    await db.query(`
      UPDATE cbt_exams SET title = 'Updated JEE Mock', questions_data = $2 WHERE id = $1
    `, [validExamId, JSON.stringify(updatedExam)]);

    const updatedRaw = (await db.query('SELECT * FROM cbt_exams_raw WHERE id = $1', [validExamId])).rows[0];
    assert.equal(updatedRaw.title, 'Updated JEE Mock');
    assert.equal(updatedRaw.questions_data.questions.Physics[0].text, 'Updated Physics Q1');

    const updatedAnswerRow = (await db.query('SELECT * FROM cbt_exam_answers WHERE exam_id = $1', [validExamId])).rows[0];
    assert.equal(updatedAnswerRow.answers.p1.correct_answer, '3');

    // =========================================================================
    // 6. REFERENTIAL INTEGRITY SAFEGUARDS
    // =========================================================================
    // Rejection: Invalid exam reference for result or session
    await assert.rejects(
      db.query(`INSERT INTO student_results (exam_id, student_id, total_score) VALUES ('non-existent-exam', 'S1', 10)`),
      /Referential integrity violation: exam_id "non-existent-exam" does not exist/
    );
    await assert.rejects(
      db.query(`INSERT INTO active_sessions (id, student_id, exam_id) VALUES ('s1_fake', 'S1', 'non-existent-exam')`),
      /Referential integrity violation: exam_id "non-existent-exam" does not exist/
    );

    // Deleting an exam with student results is BLOCKED
    await db.query(`
      INSERT INTO student_results (exam_id, student_id, student_name, total_score)
      VALUES ($1, 'STUDENT-01', 'Candidate One', 50)
    `, [validExamId]);

    await assert.rejects(
      db.query('DELETE FROM cbt_exams WHERE id = $1', [validExamId]),
      /Cannot delete exam .* because student submission results exist/
    );
    const stillExists = (await db.query('SELECT id FROM cbt_exams_raw WHERE id = $1', [validExamId])).rows;
    assert.equal(stillExists.length, 1);

    // Deleting a class with enrolled students is BLOCKED
    await db.query(`INSERT INTO classes (name, sections) VALUES ('Class 12', ARRAY['A', 'B'])`);
    await db.query(`INSERT INTO students (id, student_id, name, class, section) VALUES ('00000000-0000-0000-0000-000000000002', 'STU-12', 'John Doe', 'Class 12', 'A')`);

    await assert.rejects(
      db.query(`DELETE FROM classes WHERE name = 'Class 12'`),
      /Cannot delete class "Class 12" because students are currently enrolled/
    );

    // =========================================================================
    // 7. FAILURE-SAFE READ-ONLY DIAGNOSTIC SCRIPT ON MALFORMED JSON FIXTURES
    // =========================================================================
    // Disable triggers and drop check constraint to simulate historical legacy malformed rows
    await db.exec(`
      ALTER TABLE public.cbt_exams_raw DISABLE TRIGGER USER;
      ALTER TABLE public.cbt_exam_answers DISABLE TRIGGER USER;
      ALTER TABLE public.active_sessions DISABLE TRIGGER USER;
      ALTER TABLE public.cbt_exams_raw DROP CONSTRAINT IF EXISTS cbt_exams_data_valid;

      -- Scalar questions_data
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data, class, section)
      VALUES ('11111111-1111-1111-1111-111111111111', 'Malformed Scalar Exam', 'ACTIVE', '"scalar_string"'::jsonb, 'Class 12', 'InvalidSection');

      -- Number questions_data
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data)
      VALUES ('22222222-2222-2222-2222-222222222222', 'Malformed Number Exam', 'ACTIVE', '42'::jsonb);

      -- Array questions_data
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data)
      VALUES ('33333333-3333-3333-3333-333333333333', 'Malformed Array Exam', 'ACTIVE', '["a", "b"]'::jsonb);

      -- Object with scalar questions and null subjects
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data)
      VALUES ('44444444-4444-4444-4444-444444444444', 'Type Mismatch Exam', 'ACTIVE', '{"duration": "abc", "marksCorrect": -5, "subjects": null, "questions": 123}'::jsonb);

      -- Exam with duplicate subjects and blank subject
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data)
      VALUES ('55555555-5555-5555-5555-555555555555', 'Dup Subject Exam', 'ACTIVE', '{"duration": "180", "marksCorrect": "4", "marksIncorrect": "-1", "subjects": ["Math", "math", "   "], "questions": {}}'::jsonb);

      -- Exam with malformed private answer entry
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data)
      VALUES ('66666666-6666-6666-6666-666666666666', 'Private Ans Mismatch Exam', 'ACTIVE', '{"duration": "180", "marksCorrect": "4", "marksIncorrect": "-1", "subjects": ["Math"], "questions": {"Math": [{"id": "bad_ans_q", "type": "MCQ", "text": "Q", "options": ["A","B","C","D"]}]}}'::jsonb);

      INSERT INTO public.cbt_exam_answers (exam_id, answers)
      VALUES ('66666666-6666-6666-6666-666666666666', '{"bad_ans_q": {"correct_answer": "99", "subject": "WrongSubject", "type": "MCQ"}, "extra_q": {"correct_answer": "0", "subject": "Math", "type": "MCQ"}}'::jsonb);

      -- Non-UUID exam_id in active_sessions
      INSERT INTO public.active_sessions (id, student_id, exam_id)
      VALUES ('bad_session_1', 'STU-12', 'non-uuid-exam-id');

      ALTER TABLE public.cbt_exams_raw ENABLE TRIGGER USER;
      ALTER TABLE public.cbt_exam_answers ENABLE TRIGGER USER;
      ALTER TABLE public.active_sessions ENABLE TRIGGER USER;
    `);

    // Run the diagnostic script against all these malformed fixtures
    const diagnosticSql = await readFile(new URL('../scripts/diagnostic-data-quality.sql', import.meta.url), 'utf8');
    const diagResults = await db.query(diagnosticSql);

    assert.ok(Array.isArray(diagResults.rows));
    assert.ok(diagResults.rows.length > 0, 'Diagnostic must report detected issues');

    const issueTypes = new Set(diagResults.rows.map(r => r.issue_type));
    console.log('Diagnostic detected issue types:', [...issueTypes]);

    assert.ok(issueTypes.has('MALFORMED_EXAM'), 'Must detect malformed exams');
    assert.ok(issueTypes.has('EXAM_BLANK_SUBJECT'), 'Must detect blank subjects');
    assert.ok(issueTypes.has('EXAM_DUPLICATE_SUBJECT'), 'Must detect duplicate subjects');
    assert.ok(issueTypes.has('INVALID_EXAM_SECTION_ASSIGNMENT'), 'Must detect invalid exam section');
    assert.ok(issueTypes.has('PRIVATE_ANSWER_INVALID_VALUE'), 'Must detect invalid private answer value');
    assert.ok(issueTypes.has('PRIVATE_ANSWER_SUBJECT_MISMATCH'), 'Must detect private answer subject mismatch');
    assert.ok(issueTypes.has('EXTRANEOUS_ANSWER_KEY'), 'Must detect extraneous answer key');
    assert.ok(issueTypes.has('INVALID_EXAM_ID_FORMAT'), 'Must detect non-UUID exam_id in active_sessions');

    // =========================================================================
    // 8. SAFE CONSTRAINT VALIDATION PRECONDITION ABORT
    // =========================================================================
    // Verify that validate-constraints.sql strictly aborts when violations exist
    const validateConstraintsSql = await readFile(new URL('../scripts/validate-constraints.sql', import.meta.url), 'utf8');
    await assert.rejects(
      db.exec(validateConstraintsSql),
      /Constraint validation aborted/
    );
    await db.exec('ROLLBACK;');

    // =========================================================================
    // 9. LEGACY QUESTION TYPE NORMALIZATION (75 ROWS: 60 mcq, 15 nat)
    // =========================================================================
    // Drop constraint to load legacy rows that predate the NOT VALID constraint
    await db.exec(`ALTER TABLE question_bank DROP CONSTRAINT IF EXISTS question_bank_data_valid;`);

    // Insert 60 legacy 'mcq' rows and 15 legacy 'nat' rows into question_bank
    for (let i = 1; i <= 60; i++) {
      await db.query(`
        INSERT INTO question_bank (category, subject, type, question_text, options, correct_answer)
        VALUES ('Mains', 'Chemistry', 'mcq', 'Legacy Chemistry Question ${i}', '["Opt A", "Opt B", "Opt C", "Opt D"]'::jsonb, '1')
      `);
    }
    for (let i = 1; i <= 15; i++) {
      await db.query(`
        INSERT INTO question_bank (category, subject, type, question_text, options, correct_answer)
        VALUES ('Mains', 'Physics', 'nat', 'Legacy Physics Question ${i}', '[]'::jsonb, '42.5')
      `);
    }

    // Re-add constraint as NOT VALID, exactly reproducing the linked database state
    await db.exec(`
      ALTER TABLE question_bank ADD CONSTRAINT question_bank_data_valid CHECK (
        type IN ('MCQ', 'NUMERICAL', 'NAT')
        AND length(btrim(subject)) BETWEEN 1 AND 120
        AND (
          (type = 'MCQ' AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4 AND correct_answer IN ('0', '1', '2', '3'))
          OR
          (type IN ('NUMERICAL', 'NAT') AND jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 0
            AND correct_answer ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$')
        )
      ) NOT VALID;
    `);

    // Verify diagnostic detects all 75 legacy rows as INVALID_QUESTION_BANK_ROW before normalization
    const preNormDiag = await db.query(diagnosticSql);
    const preNormInvalidQb = preNormDiag.rows.filter(r => r.issue_type === 'INVALID_QUESTION_BANK_ROW');
    assert.equal(preNormInvalidQb.length, 75, 'Diagnostic must report exactly 75 invalid question bank rows before normalization');

    // Verify validate-constraints.sql aborts due to invalid question bank rows
    await assert.rejects(
      db.exec(validateConstraintsSql),
      /invalid question_bank rows found/
    );
    await db.exec('ROLLBACK;');

    // Apply guarded forward-only migration 20260910110000_normalize_legacy_question_types.sql
    const normSql = await readFile(new URL('../supabase/migrations/20260910110000_normalize_legacy_question_types.sql', import.meta.url), 'utf8');
    await db.exec(normSql);

    // Verify exactly 60 MCQ and 15 NAT exist in uppercase, and 0 lowercase exist
    const qbTypes = (await db.query(`SELECT type, count(*)::int AS cnt FROM question_bank GROUP BY type ORDER BY type`)).rows;
    assert.deepEqual(qbTypes, [
      { type: 'MCQ', cnt: 60 },
      { type: 'NAT', cnt: 15 }
    ]);

    // Clean up temporary malformed test fixtures and verify validate-constraints.sql succeeds cleanly
    await db.exec(`
      SET cbt.trusted_exam_context = 'on';
      DELETE FROM cbt_exams_raw WHERE id IN (
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
        '44444444-4444-4444-4444-444444444444',
        '55555555-5555-5555-5555-555555555555',
        '66666666-6666-6666-6666-666666666666'
      );
      DELETE FROM cbt_exam_answers WHERE exam_id = '66666666-6666-6666-6666-666666666666';
      DELETE FROM active_sessions WHERE id = 'bad_session_1';
      RESET cbt.trusted_exam_context;

      ALTER TABLE public.cbt_exams_raw ADD CONSTRAINT cbt_exams_data_valid CHECK (
        length(btrim(title)) BETWEEN 1 AND 200
        AND jsonb_typeof(questions_data) = 'object'
        AND jsonb_typeof(questions_data->'subjects') = 'array'
        AND jsonb_array_length(questions_data->'subjects') > 0
        AND jsonb_typeof(questions_data->'questions') = 'object'
        AND COALESCE(questions_data->>'duration', '') ~ '^[0-9]+$'
        AND (questions_data->>'duration')::integer BETWEEN 1 AND 600
        AND COALESCE(questions_data->>'marksCorrect', '') ~ '^[+]?[0-9]+([.][0-9]+)?$'
        AND (questions_data->>'marksCorrect')::numeric BETWEEN 0 AND 100
        AND COALESCE(questions_data->>'marksIncorrect', '') ~ '^-?[0-9]+([.][0-9]+)?$'
        AND (questions_data->>'marksIncorrect')::numeric BETWEEN -100 AND 0
      ) NOT VALID;
    `);

    // Verify diagnostic now reports zero violations on all valid data
    const postCleanDiag = await db.query(diagnosticSql);
    const postCleanIssues = postCleanDiag.rows.filter(r => r.issue_type !== 'UNVALIDATED_CONSTRAINT');
    assert.equal(postCleanIssues.length, 0, 'Diagnostic must report zero non-constraint issues after clean up and normalization');

    // Verify that validate-constraints.sql now executes all preconditions and validates all constraints cleanly
    await db.exec(validateConstraintsSql);

  } finally {
    await db.close();
  }
});
