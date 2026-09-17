import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

test('database rejects self-enrolment and grades incomplete submissions without penalties', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
        $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb);
      CREATE TABLE profiles (id uuid PRIMARY KEY, email text, name text, role text);
      CREATE TABLE students (id uuid PRIMARY KEY, student_id text, name text, class text, section text, password text);
      CREATE TABLE cbt_exams_raw (id uuid PRIMARY KEY, status text, class text, section text, questions_data jsonb);
      CREATE TABLE cbt_exam_answers (exam_id uuid, answers jsonb);
      CREATE TABLE active_sessions (id text PRIMARY KEY, student_id text, exam_id text,
        user_responses jsonb, jumbled_exam_data jsonb, time_left integer,
        started_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE student_results (exam_id text, student_id text, student_name text,
        total_score numeric, max_score numeric, correct integer, incorrect integer,
        unattempted integer, subject_scores jsonb, submitted_at timestamptz,
        UNIQUE (student_id, exam_id));
    `);
    for (const file of [
      '20260910010000_secure_account_provisioning.sql',
      '20260910020000_harden_exam_termination.sql',
      '20260910070000_fix_unanswered_submission_scoring.sql',
      '20260910080000_preserve_offline_resume_progress.sql'
    ]) {
      await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.exec('CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()');
    const userId = '00000000-0000-0000-0000-000000000001';
    const examId = '00000000-0000-0000-0000-000000000002';
    const metadata = { student_id: 'TEST', name: 'Test', class: 'Test', section: 'A', provisioned_by: 'admin', account_type: 'admin' };
    await assert.rejects(db.query('INSERT INTO auth.users VALUES ($1, $2, $3, $4)',
      [userId, 'test@example.com', {}, metadata]), /Accounts must be provisioned/);
    assert.equal((await db.query('SELECT * FROM students')).rows.length, 0);
    await db.query('INSERT INTO auth.users VALUES ($1, $2, $3, $4)',
      [userId, 'test@example.com', { provisioned_by: 'admin', account_type: 'student' }, metadata]);
    assert.equal((await db.query('SELECT role FROM profiles')).rows[0].role, 'student');
    assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'password'")).rows.length, 0);
    await db.query('INSERT INTO cbt_exams_raw VALUES ($1, $2, $3, $4, $5)',
      [examId, 'ACTIVE', 'Test', 'A', { duration: 30, marksCorrect: 4, marksIncorrect: -1 }]);
    await db.query('INSERT INTO cbt_exam_answers VALUES ($1, $2)',
      [examId, { q1: { subject: 'Math', type: 'MCQ', correct_answer: 0 } }]);
    await assert.rejects(db.query('SELECT terminate_exam($1)', [examId]), /not started correctly/);
    const sessionId = `${userId}_${examId}`;
    const serverPaper = { questions: { Math: [{ id: 'q1' }] } };
    const offlineProgress = { Math: [{ selectedOption: 0, status: 'ANSWERED' }] };
    await db.query('INSERT INTO active_sessions VALUES ($1, $2, $3, $4, $5, $6, now(), now())',
      [sessionId, 'TEST', examId, {}, serverPaper, 1800]);
    const resumed = (await db.query('SELECT start_exam_session($1, $2, $3) AS result',
      [examId, { forged: true }, offlineProgress])).rows[0].result;
    assert.deepEqual(resumed.jumbled_exam_data, serverPaper);
    assert.deepEqual(resumed.user_responses, offlineProgress);
    assert.ok(resumed.time_left > 0 && resumed.time_left <= 1800);
    await db.exec('DELETE FROM active_sessions');
    for (const [responses, expected] of [
      [[], [0, 0, 0, 1]],
      [[{ question_id: 'q1', selected_option: 0 }], [0, 0, 0, 1]],
      [[{ question_id: 'q1', status: 'ANSWERED', selected_option: null }], [0, 0, 0, 1]],
      [[{ question_id: 'q1', status: 'ANSWERED', selected_option: ' ' }], [0, 0, 0, 1]],
      [[{ question_id: null, status: 'ANSWERED', selected_option: 0 }], [0, 0, 0, 1]],
      [[{ question_id: 'q1', status: 'ANSWERED', selected_option: 0 }], [4, 1, 0, 0]],
      [[{ question_id: 'q1', status: 'ANSWERED_MARKED', selected_option: 1 }], [-1, 0, 1, 0]]
    ]) {
      await db.exec('DELETE FROM student_results');
      await db.query('INSERT INTO active_sessions (id, student_id, exam_id, started_at) VALUES ($1, $2, $3, now())',
        [sessionId, 'TEST', examId]);
      const result = (await db.query('SELECT submit_exam($1, $2) AS result', [examId, JSON.stringify(responses)])).rows[0].result;
      assert.deepEqual([result.totalScore, result.correct, result.incorrect, result.unattempted], expected, JSON.stringify(responses));
      const retry = (await db.query('SELECT submit_exam($1, $2) AS result', [examId, '[]'])).rows[0].result;
      assert.deepEqual(retry, result);
      assert.equal((await db.query('SELECT * FROM active_sessions')).rows.length, 0);
      assert.equal((await db.query('SELECT * FROM student_results')).rows.length, 1);
    }
  } finally {
    await db.close();
  }
});
