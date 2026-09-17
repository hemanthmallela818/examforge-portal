import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { normalizeExamListRow } from '../src/examListPaging.js';

test('exam summaries reject malformed metadata instead of showing misleading cards', () => {
  const valid = { id: 'exam-1', title: 'JEE Mock', status: 'PENDING', class: '12', section: 'A', created_at: '2026-01-01', duration: '180', total_questions: '75', subjects: ['Physics'] };
  assert.equal(normalizeExamListRow(valid).questionsData.totalQuestions, 75);
  assert.throws(() => normalizeExamListRow({ ...valid, duration: 'not-a-number' }), /invalid examination counts/);
  assert.throws(() => normalizeExamListRow({ ...valid, total_questions: '-1' }), /invalid examination counts/);
  assert.throws(() => normalizeExamListRow({ ...valid, subjects: 'Physics' }), /invalid examination subjects/);
});

test('exam-list RPC is AAL2-only, bounded, answer-free, searchable, and correctly paginated', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE FUNCTION public.is_admin_aal2() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT current_setting('test.admin', true) = 'on' $$;
      CREATE TABLE public.cbt_exams_raw (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text NOT NULL,
        status text NOT NULL DEFAULT 'PENDING',
        questions_data jsonb NOT NULL,
        class text,
        section text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO public.cbt_exams_raw (title, status, questions_data, class, section, created_at)
      SELECT
        CASE WHEN number = 9 THEN 'Literal % Exam' ELSE 'JEE Mock ' || number END,
        CASE WHEN number % 3 = 0 THEN 'ACTIVE' WHEN number % 3 = 1 THEN 'PENDING' ELSE 'ENDED' END,
        jsonb_build_object(
          'duration', 180,
          'totalQuestions', number,
          'subjects', jsonb_build_array('Physics', 'Chemistry'),
          'questions', jsonb_build_object('Physics', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'correctAnswer', 'SECRET-' || number)))
        ),
        CASE WHEN number % 2 = 0 THEN '12' ELSE '11' END,
        CASE WHEN number % 2 = 0 THEN 'A' ELSE 'B' END,
        '2026-01-01'::timestamptz + number * interval '1 second'
      FROM generate_series(1, 55) AS number;
      SELECT set_config('test.admin', 'on', false);
    `);
    const migration = await readFile(new URL('../supabase/migrations/20260910310000_stage19_paginated_exam_list.sql', import.meta.url), 'utf8');
    await db.exec(migration);

    const first = (await db.query(`SELECT public.get_admin_exam_list_page(0, 24, NULL, NULL) AS page`)).rows[0].page;
    assert.equal(first.total, 55);
    assert.equal(first.rows.length, 24);
    assert.equal(first.rows[0].title, 'JEE Mock 55');
    assert.ok(first.rows.every(row => !Object.hasOwn(row, 'questions_data') && JSON.stringify(row).includes('SECRET-') === false));
    const last = (await db.query(`SELECT public.get_admin_exam_list_page(2, 24, NULL, NULL) AS page`)).rows[0].page;
    assert.equal(last.rows.length, 7);

    const active = (await db.query(`SELECT public.get_admin_exam_list_page(0, 24, NULL, 'ACTIVE') AS page`)).rows[0].page;
    assert.equal(active.total, 18);
    assert.ok(active.rows.every(row => row.status === 'ACTIVE'));
    const classSearch = (await db.query(`SELECT public.get_admin_exam_list_page(0, 24, '12', NULL) AS page`)).rows[0].page;
    assert.equal(classSearch.total, 27);
    const wildcard = (await db.query(`SELECT public.get_admin_exam_list_page(0, 24, '%', NULL) AS page`)).rows[0].page;
    assert.equal(wildcard.total, 1);

    await assert.rejects(db.query(`SELECT public.get_admin_exam_list_page(-1, 24, NULL, NULL)`), /Page number/);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_list_page(0, 101, NULL, NULL)`), /Page size/);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_list_page(0, 24, NULL, 'DRAFT')`), /status filter/);
    await db.query(`SELECT set_config('test.admin', 'off', false)`);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_list_page(0, 24, NULL, NULL)`), /AAL2/);
  } finally {
    await db.close();
  }
});

test('administrator dashboard uses a paged exam list and independent full detail state', async () => {
  const source = await readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8');
  assert.match(source, /get_admin_exam_list_page/);
  assert.match(source, /page_size_param:\s*EXAM_LIST_PAGE_SIZE/);
  assert.match(source, /Examination list pages/);
  assert.match(source, /const \[activeExamDetail, setActiveExamDetail\]/);
  assert.match(source, /const exam = activeExamDetail/);
  assert.match(source, /Retry exam details/);
  assert.doesNotMatch(source, /setActiveExamId\(null\);\s*return null/);
  assert.doesNotMatch(source, /from\('cbt_exams'\)\.select\(`\s*id, title, status/);
});
