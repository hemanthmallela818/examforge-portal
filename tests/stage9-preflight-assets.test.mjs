import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import {
  validateImageMimeAndSize,
  verifyImageMagicBytes,
  validateImageDimensions,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_DIMENSION
} from '../src/imageValidation.js';
import {
  checkLatexDelimiters,
  validateExamPreflight
} from '../src/examPreflightLogic.js';
import {
  validateImportQuestions,
  exportFailedImportRows
} from '../src/importLogic.js';

test('Stage 9: Exam Preflight, Image Security, Reference-Aware Storage Cleanup, and Import Diagnostics', async (t) => {
  // --------------------------------------------------------------------------
  // 1. Image Security and Decompression-Bomb Protection
  // --------------------------------------------------------------------------
  await t.test('Image validation: rejects SVG, 0-byte, oversized files, and MIME spoofing', async () => {
    // 1. SVG rejection
    const svgFile = { name: 'diagram.svg', type: 'image/svg+xml', size: 1024 };
    const svgRes = validateImageMimeAndSize(svgFile);
    assert.strictEqual(svgRes.valid, false);
    assert.match(svgRes.error, /SVG files are not permitted/i);

    // 2. SVG by extension even if MIME disguised
    const disguisedSvg = { name: 'test.SVG', type: 'image/png', size: 1024 };
    const disguisedSvgRes = validateImageMimeAndSize(disguisedSvg);
    assert.strictEqual(disguisedSvgRes.valid, false);
    assert.match(disguisedSvgRes.error, /SVG files are not permitted/i);

    // 3. 0-byte file
    const emptyFile = { name: 'empty.png', type: 'image/png', size: 0 };
    const emptyRes = validateImageMimeAndSize(emptyFile);
    assert.strictEqual(emptyRes.valid, false);
    assert.match(emptyRes.error, /empty/i);

    // 4. File > 5MB
    const oversizedFile = { name: 'big.jpg', type: 'image/jpeg', size: MAX_IMAGE_FILE_BYTES + 1 };
    const oversizedRes = validateImageMimeAndSize(oversizedFile);
    assert.strictEqual(oversizedRes.valid, false);
    assert.match(oversizedRes.error, /exceeds the 5 MB limit/i);

    // 5. Valid MIME and size
    const validFile = { name: 'photo.jpg', type: 'image/jpeg', size: 500 * 1024 };
    const validRes = validateImageMimeAndSize(validFile);
    assert.strictEqual(validRes.valid, true);
  });

  await t.test('Image magic bytes verification: sniffs genuine JPEG, PNG, WebP headers', async () => {
    // Helper to simulate a File/Blob with slice().arrayBuffer()
    const mockFileWithBytes = (bytes) => ({
      slice: () => ({
        arrayBuffer: async () => new Uint8Array(bytes).buffer
      })
    });

    // Valid JPEG: FF D8 FF
    const jpegFile = mockFileWithBytes([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    const jpegRes = await verifyImageMagicBytes(jpegFile);
    assert.strictEqual(jpegRes.valid, true);
    assert.strictEqual(jpegRes.format, 'image/jpeg');

    // Valid PNG: 89 50 4E 47 0D 0A 1A 0A
    const pngFile = mockFileWithBytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
    const pngRes = await verifyImageMagicBytes(pngFile);
    assert.strictEqual(pngRes.valid, true);
    assert.strictEqual(pngRes.format, 'image/png');

    // Valid WebP: 52 49 46 46 (RIFF) ... 57 45 42 50 (WEBP)
    const webpFile = mockFileWithBytes([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // size
      0x57, 0x45, 0x42, 0x50  // WEBP
    ]);
    const webpRes = await verifyImageMagicBytes(webpFile);
    assert.strictEqual(webpRes.valid, true);
    assert.strictEqual(webpRes.format, 'image/webp');

    // Spoofed text file disguised as image
    const textSpoof = mockFileWithBytes([0x3C, 0x21, 0x44, 0x4F, 0x43, 0x54, 0x59, 0x50, 0x45]); // <!DOCTYPE
    const textRes = await verifyImageMagicBytes(textSpoof);
    assert.strictEqual(textRes.valid, false);
    assert.match(textRes.error, /Header verification failed/i);

    // Truncated header (< 4 bytes)
    const truncated = mockFileWithBytes([0xFF, 0xD8]);
    const truncRes = await verifyImageMagicBytes(truncated);
    assert.strictEqual(truncRes.valid, false);
  });

  await t.test('Image dimension & decompression-bomb limits', () => {
    // Normal resolution
    const normal = validateImageDimensions(1920, 1080);
    assert.strictEqual(normal.valid, true);

    // Dimension > 4096 px
    const excessiveWidth = validateImageDimensions(MAX_IMAGE_DIMENSION + 1, 100);
    assert.strictEqual(excessiveWidth.valid, false);
    assert.match(excessiveWidth.error, /exceed the maximum allowed/i);

    // Decompression bomb: 4000 x 4000 = 16,000,000 px is right at limit
    const atLimit = validateImageDimensions(4000, 4000);
    assert.strictEqual(atLimit.valid, true);

    // 4001 x 4000 = 16,004,000 > 16 MP limit
    const bomb = validateImageDimensions(4001, 4000);
    assert.strictEqual(bomb.valid, false);
    assert.match(bomb.error, /Decompression-bomb protection/i);
  });

  // --------------------------------------------------------------------------
  // 2. Client-Side Preflight Logic & LaTeX Delimiter Checking
  // --------------------------------------------------------------------------
  await t.test('LaTeX math delimiter balance checks', () => {
    // Balanced inline
    assert.strictEqual(checkLatexDelimiters('Solve for $x^2 + 5 = 9$.').balanced, true);

    // Balanced display
    assert.strictEqual(checkLatexDelimiters('Evaluate: $$\\int_0^1 x dx$$').balanced, true);

    // Escaped dollar signs do not count
    assert.strictEqual(checkLatexDelimiters('The price was \\$50 for $x$ items.').balanced, true);

    // Unmatched inline delimiter
    const unclosedInline = checkLatexDelimiters('Find value of $x^2 + 1');
    assert.strictEqual(unclosedInline.balanced, false);
    assert.match(unclosedInline.reason, /Unmatched inline math delimiter/i);

    // Unmatched display delimiter
    const unclosedDisplay = checkLatexDelimiters('Equation: $$\\frac{a}{b}');
    assert.strictEqual(unclosedDisplay.balanced, false);
    assert.match(unclosedDisplay.reason, /Unmatched display math delimiter/i);
  });

  await t.test('Exam Preflight Validation: metadata, question completeness, and asset protocol', () => {
    const validExam = {
      title: 'JEE Mains Mock Test 1',
      class: 'Class 12',
      section: 'A',
      duration: 180,
      marksCorrect: 4,
      marksIncorrect: -1,
      subjects: ['Physics'],
      questions: {
        Physics: [
          {
            id: 'p1',
            type: 'MCQ',
            text: 'What is the velocity?',
            options: ['1 m/s', '2 m/s', '3 m/s', '4 m/s'],
            correctAnswer: '0',
            questionImageUrl: 'questions/diagram1.png'
          }
        ]
      }
    };

    const validRes = validateExamPreflight(validExam);
    assert.strictEqual(validRes.valid, true);
    assert.strictEqual(validRes.errors.length, 0);
    assert.strictEqual(validRes.storageAssets.length, 1);
    assert.strictEqual(validRes.storageAssets[0], 'questions/diagram1.png');

    // Insecure http asset URL
    const insecureExam = {
      ...validExam,
      questions: {
        Physics: [
          {
            id: 'p1',
            type: 'MCQ',
            text: 'What is the velocity?',
            options: ['1 m/s', '2 m/s', '3 m/s', '4 m/s'],
            correctAnswer: '0',
            questionImageUrl: 'http://example.com/insecure.png'
          }
        ]
      }
    };
    const insecureRes = validateExamPreflight(insecureExam);
    assert.strictEqual(insecureRes.valid, false);
    assert.ok(insecureRes.errors.some(e => e.toLowerCase().includes('insecure')));

    // Incomplete MCQ options
    const brokenMcqExam = {
      ...validExam,
      questions: {
        Physics: [
          {
            id: 'p1',
            type: 'MCQ',
            text: 'Broken MCQ',
            options: ['Option A', ''], // only 2 options and one empty
            correctAnswer: '0'
          }
        ]
      }
    };
    const brokenMcqRes = validateExamPreflight(brokenMcqExam);
    assert.strictEqual(brokenMcqRes.valid, false);
    assert.ok(brokenMcqRes.errors.some(e => e.includes('4 options')));

    const duplicateAndExternalExam = {
      ...validExam,
      subjects: ['Physics', 'Physics'],
      questions: {
        Physics: [
          validExam.questions.Physics[0],
          { ...validExam.questions.Physics[0], questionImageUrl: 'https://tracker.example/question.png' }
        ],
        History: []
      }
    };
    const duplicateAndExternalRes = validateExamPreflight(duplicateAndExternalExam);
    assert.strictEqual(duplicateAndExternalRes.valid, false);
    assert.ok(duplicateAndExternalRes.errors.some(e => e.includes('Duplicate subject')));
    assert.ok(duplicateAndExternalRes.errors.some(e => e.includes('Duplicate question ID')));
    assert.ok(duplicateAndExternalRes.errors.some(e => e.includes('undeclared subject')));
    assert.ok(duplicateAndExternalRes.errors.some(e => e.includes('private exam-assets path')));
  });

  // --------------------------------------------------------------------------
  // 3. Row-Specific Import Failures and Safe Retry Export
  // --------------------------------------------------------------------------
  await t.test('Import logic: assigns row numbers, codes, and generates failed rows export', () => {
    const rawBatch = [
      {
        question_number: 1,
        question_text: 'Valid question text',
        question_type: 'MCQ',
        options: ['Opt A', 'Opt B', 'Opt C', 'Opt D'],
        correct_answer: 'A',
        subject: 'Physics',
        has_image_or_diagram: false
      },
      {
        question_number: 2,
        question_text: '', // Empty text error
        question_type: 'MCQ',
        options: ['Opt A', 'Opt B', 'Opt C', 'Opt D'],
        correct_answer: 'B',
        subject: 'Physics',
        has_image_or_diagram: false
      },
      {
        question_number: 3,
        question_text: 'Invalid subject and options count',
        question_type: 'MCQ',
        options: ['Opt A', 'Opt B'],
        correct_answer: 'C',
        subject: 'History', // Invalid subject
        has_image_or_diagram: false
      }
    ];

    const validated = validateImportQuestions(rawBatch, []);
    assert.strictEqual(validated.length, 3);

    // Row 1 is valid
    assert.strictEqual(validated[0].approved, true);
    assert.strictEqual(validated[0].rowNumber, 1);

    // Row 2 failed with empty text
    assert.strictEqual(validated[1].approved, false);
    assert.strictEqual(validated[1].rowNumber, 2);
    assert.ok(validated[1].rowErrors.some(e => e.code === 'ROW_EMPTY_TEXT'));

    // Row 3 failed with invalid subject and invalid options count
    assert.strictEqual(validated[2].approved, false);
    assert.strictEqual(validated[2].rowNumber, 3);
    assert.ok(validated[2].rowErrors.some(e => e.code === 'ROW_INVALID_SUBJECT'));
    assert.ok(validated[2].rowErrors.some(e => e.code === 'ROW_INVALID_OPTIONS_COUNT'));

    // Export failed rows
    const exportJson = exportFailedImportRows(validated);
    const parsed = JSON.parse(exportJson);
    assert.strictEqual(parsed.version, '1.0');
    assert.strictEqual(parsed.export_metadata.total_failed_rows, 2);
    assert.strictEqual(parsed.questions.length, 2);
    assert.strictEqual(parsed.questions[0].question_number, 2);
    assert.strictEqual(parsed.questions[1].question_number, 3);
    assert.ok(parsed.questions[0].diagnostics.errors.length > 0);
  });

  // --------------------------------------------------------------------------
  // 4. PostgreSQL Migration 20260910260000 DB Validation, Preflight Gate & Cleanup
  // --------------------------------------------------------------------------
  await t.test('Database: preflight validation, storage physical presence gate, and unreferenced asset cleanup', async () => {
    const db = new PGlite();

    // 1. Base schema & roles
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
        session_token text,
        is_active boolean DEFAULT true
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
        created_at timestamptz DEFAULT now(),
        updated_at timestamptz DEFAULT now(),
        last_heartbeat timestamptz DEFAULT now(),
        is_terminated boolean DEFAULT false,
        version integer DEFAULT 1,
        CONSTRAINT active_sessions_student_exam_unique UNIQUE (student_id, exam_id)
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

      CREATE OR REPLACE FUNCTION public.get_my_role()
      RETURNS text
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
        SELECT role FROM public.profiles WHERE id = auth.uid();
      $$;

      CREATE OR REPLACE FUNCTION public.get_student_id_by_auth()
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

    // 2. Apply all migrations up to Stage 9
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
      '20260910250000_stage8_scale_indexes.sql',
      '20260910260000_stage9_preflight_and_asset_integrity.sql',
      '20260910270000_stage9_integrity_corrections.sql'
    ]) {
      const sql = await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await db.exec(sql);
    }

    await db.exec(`
      DROP TRIGGER IF EXISTS handle_cbt_exams_modification_trigger ON public.cbt_exams;
      CREATE TRIGGER handle_cbt_exams_modification_trigger
        INSTEAD OF INSERT OR UPDATE OR DELETE ON public.cbt_exams
        FOR EACH ROW EXECUTE FUNCTION public.handle_cbt_exams_modification();
    `);

    // Set up test admin with AAL2
    const adminId = '11111111-1111-1111-1111-111111111111';
    await db.exec(`
      INSERT INTO auth.users (id, raw_app_meta_data) VALUES ('${adminId}', '{"role":"admin"}'::jsonb);
      INSERT INTO profiles (id, email, name, role) VALUES ('${adminId}', 'admin@school.test', 'Admin User', 'admin');
      INSERT INTO classes (name, sections) VALUES ('Class 12', ARRAY['A', 'B']);
      INSERT INTO storage.buckets (id, name, public) VALUES ('exam-assets', 'exam-assets', false);
    `);

    const setAdminContext = async () => {
      await db.exec(`
        SET ROLE authenticated;
        SELECT set_config('my.test.uid', '${adminId}', false);
        SELECT set_config('my.test.role', 'authenticated', false);
        SELECT set_config('request.jwt.claims', '{"sub":"${adminId}","role":"authenticated","aal":"aal2"}', false);
      `);
    };

    await setAdminContext();

    // 3. Test asset reference detection: is_exam_asset_referenced
    await db.exec(`
      INSERT INTO storage.objects (bucket_id, name) VALUES
      ('exam-assets', 'questions/used_in_exam.png'),
      ('exam-assets', 'questions/used_in_bank.png'),
      ('exam-assets', 'questions/orphaned_file.png');

      INSERT INTO question_bank (category, subject, type, question_text, correct_answer, question_image_url)
      VALUES ('Mains', 'Physics', 'NUMERICAL', 'Bank question', '10', 'questions/used_in_bank.png');
    `);

    // Insert an exam referencing 'questions/used_in_exam.png'
    const examQuestionsData = {
      duration: '180',
      marksCorrect: '4',
      marksIncorrect: '-1',
      subjects: ['Physics'],
      questions: {
        Physics: [
          {
            id: 'q-exist-1',
            type: 'MCQ',
            text: 'Question with storage asset',
            options: ['A', 'B', 'C', 'D'],
            correctAnswer: '0',
            questionImageUrl: 'questions/used_in_exam.png'
          }
        ]
      }
    };

    const insertRes = await db.query(`
      INSERT INTO cbt_exams (title, class, section, questions_data)
      VALUES ('Test Preflight Exam', 'Class 12', 'A', $1::jsonb)
      RETURNING id;
    `, [JSON.stringify(examQuestionsData)]);

    const examId = insertRes.rows[0].id;

    // Check is_exam_asset_referenced
    const refExam = await db.query(`SELECT public.is_exam_asset_referenced('questions/used_in_exam.png') AS res;`);
    assert.strictEqual(refExam.rows[0].res, true);

    const refBank = await db.query(`SELECT public.is_exam_asset_referenced('questions/used_in_bank.png') AS res;`);
    assert.strictEqual(refBank.rows[0].res, true);

    const refOrphan = await db.query(`SELECT public.is_exam_asset_referenced('questions/orphaned_file.png') AS res;`);
    assert.strictEqual(refOrphan.rows[0].res, false);

    // 4. Test preflight_validate_exam on exam with verified storage assets
    const preflightValid = await db.query(`
      SELECT public.preflight_validate_exam($1::uuid) AS res;
    `, [examId]);
    const validReport = preflightValid.rows[0].res;
    assert.strictEqual(validReport.valid, true);
    assert.strictEqual(validReport.errors.length, 0);
    assert.strictEqual(validReport.totalQuestions, 1);
    assert.strictEqual(validReport.verifiedAssets, 1);

    // 5. Test status transition to ACTIVE: succeeds when preflight passes
    await db.exec(`
      UPDATE cbt_exams SET status = 'ACTIVE' WHERE id = '${examId}';
    `);
    const statusCheck = await db.query(`SELECT status FROM cbt_exams_raw WHERE id = '${examId}';`);
    assert.strictEqual(statusCheck.rows[0].status, 'ACTIVE');

    // A newly-created ACTIVE paper succeeds because its private answer key is
    // committed before the authoritative activation preflight runs.
    const activeInsert = await db.query(`
      INSERT INTO cbt_exams (title, status, class, section, questions_data)
      VALUES ('Immediately Active Exam', 'ACTIVE', 'Class 12', 'A', $1::jsonb)
      RETURNING id;
    `, [JSON.stringify({ ...examQuestionsData, questions: { Physics: [{ ...examQuestionsData.questions.Physics[0], id: 'q-active-insert' }] } })]);
    assert.ok(activeInsert.rows[0].id);

    // Corruption of the private key must be visible to preflight, even though
    // answer data is intentionally absent from the public exam JSON.
    await db.exec(`
      RESET ROLE;
      SELECT set_config('cbt.trusted_exam_context', 'on', false);
      UPDATE cbt_exam_answers SET answers = '{}'::jsonb WHERE exam_id = '${examId}';
      SELECT set_config('cbt.trusted_exam_context', 'off', false);
    `);
    await setAdminContext();
    const missingAnswerReport = (await db.query(
      `SELECT public.preflight_validate_exam($1::uuid) AS res`, [examId]
    )).rows[0].res;
    assert.strictEqual(missingAnswerReport.valid, false);
    assert.ok(missingAnswerReport.errors.some(error => /answer/i.test(error)));

    // 6. Test preflight gate blocking activation when a storage asset is MISSING
    const brokenExamData = {
      duration: '180',
      marksCorrect: '4',
      marksIncorrect: '-1',
      subjects: ['Physics'],
      questions: {
        Physics: [
          {
            id: 'q-missing-1',
            type: 'MCQ',
            text: 'Question referencing deleted asset',
            options: ['A', 'B', 'C', 'D'],
            correctAnswer: '1',
            questionImageUrl: 'questions/non_existent_file_404.png' // Missing from storage.objects!
          }
        ]
      }
    };

    const brokenExamRes = await db.query(`
      INSERT INTO cbt_exams (title, class, section, questions_data)
      VALUES ('Exam With Missing Asset', 'Class 12', 'A', $1::jsonb)
      RETURNING id;
    `, [JSON.stringify(brokenExamData)]);
    const brokenExamId = brokenExamRes.rows[0].id;

    // preflight report reports missing asset error
    const preflightMissing = await db.query(`
      SELECT public.preflight_validate_exam($1::uuid) AS res;
    `, [brokenExamId]);
    const missingReport = preflightMissing.rows[0].res;
    assert.strictEqual(missingReport.valid, false);
    assert.ok(missingReport.errors.some(e => e.includes('references missing storage asset: "questions/non_existent_file_404.png"')));

    // Attempting to activate this broken exam directly MUST fail with PostgreSQL trigger exception!
    await assert.rejects(async () => {
      await db.exec(`UPDATE cbt_exams SET status = 'ACTIVE' WHERE id = '${brokenExamId}';`);
    }, /preflight validation failed/i);

    // 7. Scan in PostgreSQL, delete bytes through the Storage API boundary,
    // then record the verified cleanup audit.
    const unrefAssets = await db.query(`SELECT * FROM public.get_unreferenced_exam_assets();`);
    assert.strictEqual(unrefAssets.rows.length, 1);
    assert.strictEqual(unrefAssets.rows[0].name, 'questions/orphaned_file.png');

    await assert.rejects(
      db.query(`SELECT public.cleanup_unreferenced_exam_assets() AS res;`),
      /permission denied|Direct database cleanup is disabled/i
    );

    // Simulate the trusted Storage API removing both bytes and metadata.
    await db.exec(`
      RESET ROLE;
      DELETE FROM storage.objects
      WHERE bucket_id = 'exam-assets' AND name = 'questions/orphaned_file.png';
    `);
    await setAdminContext();
    const cleanupRes = await db.query(
      `SELECT public.record_exam_asset_cleanup(ARRAY['questions/orphaned_file.png']) AS res;`
    );
    assert.strictEqual(cleanupRes.rows[0].res.deleted_count, 1);

    // Verify orphaned file was deleted from storage.objects
    const remainingObjects = await db.query(`SELECT name FROM storage.objects WHERE bucket_id = 'exam-assets' ORDER BY name;`);
    assert.deepStrictEqual(remainingObjects.rows.map(r => r.name), [
      'questions/used_in_bank.png',
      'questions/used_in_exam.png'
    ]);

    // Verify audit event was logged for cleanup
    const auditRes = await db.query(`
      SELECT action, target_type, target_id, metadata
      FROM public.admin_audit_events
      WHERE action = 'CLEANUP_UNREFERENCED_ASSETS';
    `);
    assert.strictEqual(auditRes.rows.length, 1);
    assert.strictEqual(auditRes.rows[0].target_type, 'STORAGE');
    assert.strictEqual(auditRes.rows[0].target_id, 'exam-assets');
    assert.strictEqual(auditRes.rows[0].metadata.deleted_count, 1);
  });
});
