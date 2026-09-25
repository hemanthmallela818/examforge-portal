import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readExamSource } from './support/examSource.mjs';
import { adminSource } from './support/adminSource.mjs';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Stage 27 keeps detailed answer reviews private and administrator-audited', async () => {
  const migration = await source('supabase/migrations/20260923143000_stage27_lockdown_reviews_and_admin_reliability.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.student_result_reviews/);
  assert.match(migration, /ALTER TABLE public\.student_result_reviews ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.student_result_reviews FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /IF NOT public\.is_admin_aal2\(\)/);
  assert.match(migration, /VIEW_STUDENT_ANSWER_REVIEW/);
  assert.match(migration, /capture_student_result_review_after_insert/);
  assert.match(migration, /subject_time_seconds/);
});

test('Stage 27 lockdown removes acknowledgement flow and uses strict browser controls', async () => {
  const [app, css] = await Promise.all([readExamSource(), source('src/index.css')]);
  assert.doesNotMatch(app, /I Understand - Return to Exam/);
  assert.match(app, /requestFullscreen\(\{ keyboardLock: 'browser' \}\)/);
  assert.match(app, /navigator\.keyboard\?\.lock/);
  assert.match(app, /document\.addEventListener\('visibilitychange'/);
  assert.match(app, /document\.addEventListener\('copy'/);
  assert.match(app, /className="exam-security-cover"/);
  assert.match(app, /exam-candidate-watermark/);
  assert.match(css, /@media print/);
});

test('Stage 27 administrator UI exposes private per-student review', async () => {
  const [dashboard, migration] = await Promise.all([
    adminSource(),
    source('supabase/migrations/20260923143000_stage27_lockdown_reviews_and_admin_reliability.sql')
  ]);
  assert.match(dashboard, /get_admin_student_result_review/);
  assert.match(dashboard, /Reveal answers/);
  assert.match(dashboard, /subject_time_seconds/);
  assert.doesNotMatch(migration, /answer_snapshot|paper_snapshot/);
});
