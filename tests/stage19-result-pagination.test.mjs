import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { parseResultExportPageResponse, parseResultPageResponse, validateCompleteResultExport } from '../src/resultPaging.js';

test('ranked result pages and assembled exports fail closed on malformed or changing data', () => {
  const row = (id, studentId, rank = 1) => ({ id, exam_id: 'exam', student_id: studentId, student_name: `Name ${studentId}`, total_score: '4', max_score: '8', subject_scores: { Physics: 4 }, subject_ranks: { Physics: rank }, total_rank: rank });
  const analytics = { average_score: 4, highest_score: 4, lowest_score: 4, excluded_from_distribution: 0,
    distribution: [{ name: '0-20%', count: 0 }, { name: '21-40%', count: 0 }, { name: '41-60%', count: 2 }, { name: '61-80%', count: 0 }, { name: '81-100%', count: 0 }],
    subject_averages: [{ name: 'Physics', score: 4 }] };
  const parsed = parseResultPageResponse({
    page: 0, page_size: 2, total: 2, result_count: 2, subjects: ['Physics'],
    analytics,
    rows: [row('a', 'S1'), row('b', 'S2')]
  }, { expectedPage: 0, expectedPageSize: 2 });
  assert.equal(parsed.rows[0].totalScore, 4);
  assert.equal(validateCompleteResultExport([parsed.rows], 2).length, 2);
  assert.throws(() => validateCompleteResultExport([[parsed.rows[0], parsed.rows[0]]], 2), /result set changed/);
  assert.throws(() => parseResultPageResponse({ page: 0, page_size: 2, total: 2, result_count: 2, subjects: ['Physics'], analytics,
    rows: [row('a', 'S1'), { ...row('b', 'S2'), subject_ranks: { Physics: 0 } }] }, { expectedPage: 0, expectedPageSize: 2 }), /Physics rank/);
  assert.throws(() => parseResultPageResponse({ page: 0, page_size: 2, total: 2, result_count: 2, subjects: ['Physics'],
    analytics: { ...analytics, distribution: analytics.distribution.map((item, index) => index === 0 ? { ...item, count: 1 } : item) },
    rows: [row('a', 'S1'), row('b', 'S2')] }, { expectedPage: 0, expectedPageSize: 2 }), /inconsistent result analytics/);
  assert.throws(() => parseResultPageResponse({ page: 0, page_size: 2, rows: [], result_count: 0, total: 0, subjects: ['Physics'], analytics: {} }, { expectedPage: 0, expectedPageSize: 2 }), /analytics for an empty/);
  const exportPage = parseResultExportPageResponse({ result_count: 2, subjects: ['Physics'], rows: [
    { id: 'a', exam_id: 'exam', student_id: 'S1', student_name: 'One', total_score: 1, max_score: 4, subject_scores: { Physics: 1 } }
  ], has_more: true, next_student_id: 'S1' }, { expectedCount: 2, pageSize: 1, afterCursor: null });
  assert.equal(exportPage.nextCursor, 'S1');
  assert.throws(() => parseResultExportPageResponse({ result_count: 2, subjects: [], rows: exportPage.rows.map(result => ({ ...result, student_id: 'S1' })), has_more: false, next_student_id: 'S1' }, { expectedCount: 2, pageSize: 1, afterCursor: 'S1' }), /cursor did not advance/);
});

test('result-page RPC preserves global ranks and analytics while paging and filtering', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE FUNCTION public.is_admin_aal2() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT current_setting('test.admin', true) = 'on' $$;
      CREATE TABLE public.cbt_exams_raw (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, status text NOT NULL,
        questions_data jsonb NOT NULL, class text, section text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE public.student_results (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), exam_id text NOT NULL, student_id text NOT NULL,
        student_name text, total_score numeric, max_score numeric, correct integer, incorrect integer,
        unattempted integer, subject_scores jsonb, submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (student_id, exam_id)
      );
      CREATE VIEW public.cbt_exams AS SELECT * FROM public.cbt_exams_raw;
      INSERT INTO public.cbt_exams_raw (id, title, status, questions_data)
      VALUES ('10000000-0000-0000-0000-000000000001', 'Rank Test', 'ENDED',
        '{"subjects":["Physics","Chemistry"],"duration":180,"totalQuestions":50,"questions":{}}');
      INSERT INTO public.student_results (exam_id, student_id, student_name, total_score, max_score, correct, incorrect, unattempted, subject_scores, submitted_at)
      SELECT '10000000-0000-0000-0000-000000000001',
        CASE WHEN number = 7 THEN 'PERCENT-%' ELSE 'STU-' || lpad(number::text, 3, '0') END,
        'Student ' || number,
        CASE WHEN number IN (124, 125) THEN 130 ELSE number END,
        125, number, 0, 0,
        jsonb_build_object('Physics', number % 50, 'Chemistry', number % 30),
        '2026-01-01'::timestamptz + number * interval '1 second'
      FROM generate_series(1, 125) AS number;
      SELECT set_config('test.admin', 'on', false);
    `);
    const migration = await readFile(new URL('../supabase/migrations/20260910320000_stage19_paginated_exam_results.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    const examId = '10000000-0000-0000-0000-000000000001';

    const first = (await db.query(`SELECT public.get_admin_exam_results_page($1, 0, 25, NULL, NULL) AS page`, [examId])).rows[0].page;
    assert.equal(first.total, 125);
    assert.equal(first.result_count, 125);
    assert.equal(first.rows.length, 25);
    assert.equal(first.rows[0].total_rank, 1);
    assert.equal(first.rows[1].total_rank, 1);
    assert.equal(Number(first.analytics.highest_score), 130);
    assert.equal(first.analytics.distribution.reduce((sum, item) => sum + Number(item.count), 0), 125);
    assert.equal(first.analytics.subject_averages.length, 2);

    const searched = (await db.query(`SELECT public.get_admin_exam_results_page($1, 0, 25, 'Student 50', NULL) AS page`, [examId])).rows[0].page;
    assert.equal(searched.total, 1);
    assert.equal(searched.result_count, 125);
    assert.equal(searched.rows[0].student_id, 'STU-050');
    assert.ok(searched.rows[0].total_rank > 1, 'search must retain the global rank');
    const wildcard = (await db.query(`SELECT public.get_admin_exam_results_page($1, 0, 25, '%', NULL) AS page`, [examId])).rows[0].page;
    assert.equal(wildcard.total, 1);

    const last = (await db.query(`SELECT public.get_admin_exam_results_page($1, 4, 25, NULL, 125) AS page`, [examId])).rows[0].page;
    assert.equal(last.rows.length, 25);
    const exportOne = (await db.query(`SELECT public.get_admin_exam_results_export_page($1, NULL, 50, 125) AS page`, [examId])).rows[0].page;
    assert.equal(exportOne.rows.length, 50);
    assert.equal(exportOne.has_more, true);
    assert.ok(exportOne.rows.every(row => !Object.hasOwn(row, 'total_rank')));
    const exportTwo = (await db.query(`SELECT public.get_admin_exam_results_export_page($1, $2, 50, 125) AS page`, [examId, exportOne.next_student_id])).rows[0].page;
    assert.equal(exportTwo.rows.length, 50);
    assert.notEqual(exportTwo.rows[0].student_id, exportOne.rows[0].student_id);
    const exportThree = (await db.query(`SELECT public.get_admin_exam_results_export_page($1, $2, 50, 125) AS page`, [examId, exportTwo.next_student_id])).rows[0].page;
    assert.equal(exportThree.rows.length, 25);
    assert.equal(exportThree.has_more, false);
    assert.equal(new Set([...exportOne.rows, ...exportTwo.rows, ...exportThree.rows].map(row => row.student_id)).size, 125);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_results_page($1, 0, 25, NULL, 124)`, [examId]), /Result set changed/);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_results_export_page($1, NULL, 50, 124)`, [examId]), /Result set changed/);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_results_page($1, 0, 501, NULL, NULL)`, [examId]), /Page size/);
    await db.query(`SELECT set_config('test.admin', 'off', false)`);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_results_page($1, 0, 25, NULL, NULL)`, [examId]), /AAL2/);
    await assert.rejects(db.query(`SELECT public.get_admin_exam_results_export_page($1, NULL, 50, 125)`, [examId]), /AAL2/);
  } finally {
    await db.close();
  }
});

test('administrator leaderboard pages results and keyset-streams audited exports', async () => {
  const [source, migration] = await Promise.all([
    readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260910320000_stage19_paginated_exam_results.sql', import.meta.url), 'utf8')
  ]);
  assert.match(source, /get_admin_exam_results_page/);
  assert.match(source, /get_admin_exam_results_export_page/);
  assert.match(source, /Leaderboard pages/);
  assert.match(source, /expected_result_count_param:\s*expectedCount/);
  assert.match(source, /validateCompleteResultExport/);
  assert.doesNotMatch(source, /from\('student_results'\)\.select\('\*'\)/);
  assert.match(migration, /SECURITY INVOKER/);
  assert.match(migration, /after_student_id_param IS NULL OR result\.student_id > after_student_id_param/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_admin_exam_results_export_page[\s\S]*FROM PUBLIC, anon/);
});
