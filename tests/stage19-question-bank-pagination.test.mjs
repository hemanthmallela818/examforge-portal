import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { normalizeQuestionBankRow, parseSelectedQuestionsResponse } from '../src/questionBankPaging.js';

test('selected-question responses require an exact, ordered match', () => {
  const row = id => ({ id, subject: 'Physics', type: 'MCQ', question_number: 1, question_text: 'Q', options: [], correct_answer: '0' });
  assert.deepEqual(parseSelectedQuestionsResponse({ requested_count: 2, rows: [row('a'), row('b')] }, ['a', 'b']).map(q => q.docId), ['a', 'b']);
  assert.throws(() => parseSelectedQuestionsResponse({ requested_count: 2, rows: [row('a')] }, ['a', 'b']), /no longer exist/);
  assert.throws(() => parseSelectedQuestionsResponse({ requested_count: 2, rows: [row('b'), row('a')] }, ['a', 'b']), /different question selection/);
  assert.throws(() => parseSelectedQuestionsResponse({ requested_count: 2, rows: [row('a'), row('a')] }, ['a', 'b']), /different question selection/);
  assert.equal(normalizeQuestionBankRow({ ...row('n'), type: 'NAT' }).type, 'NUMERICAL');
});

test('question-bank RPCs are AAL2-only, bounded, filterable, and preserve cross-page ID order', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE FUNCTION public.is_admin_aal2() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT current_setting('test.admin', true) = 'on' $$;
      CREATE TABLE public.question_bank (
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
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO public.question_bank (subject, type, question_text, options, correct_answer, created_at)
      SELECT
        CASE WHEN number <= 70 THEN 'Physics' ELSE 'Chemistry' END,
        CASE WHEN number % 2 = 0 THEN 'MCQ' ELSE 'NAT' END,
        CASE WHEN number = 5 THEN 'Literal % wildcard' ELSE 'Question ' || number END,
        CASE WHEN number % 2 = 0 THEN '["A","B","C","D"]'::jsonb ELSE '[]'::jsonb END,
        CASE WHEN number % 2 = 0 THEN '0' ELSE '12.5' END,
        '2026-01-01'::timestamptz + number * interval '1 second'
      FROM generate_series(1, 125) AS number;
      SELECT set_config('test.admin', 'on', false);
    `);
    const migration = await readFile(new URL('../supabase/migrations/20260910300000_stage19_paginated_question_bank.sql', import.meta.url), 'utf8');
    await db.exec(migration);

    const first = (await db.query(`SELECT public.get_admin_question_bank_page(0, 50, NULL, NULL, NULL) AS page`)).rows[0].page;
    assert.equal(first.total, 125);
    assert.equal(first.rows.length, 50);
    const last = (await db.query(`SELECT public.get_admin_question_bank_page(2, 50, NULL, NULL, NULL) AS page`)).rows[0].page;
    assert.equal(last.rows.length, 25);

    const physicsNumerical = (await db.query(`SELECT public.get_admin_question_bank_page(0, 50, NULL, 'Physics', 'NUMERICAL') AS page`)).rows[0].page;
    assert.equal(physicsNumerical.total, 35);
    assert.ok(physicsNumerical.rows.every(row => row.subject === 'Physics' && row.type === 'NAT'));
    const wildcard = (await db.query(`SELECT public.get_admin_question_bank_page(0, 50, '%', NULL, NULL) AS page`)).rows[0].page;
    assert.equal(wildcard.total, 1);

    const selectedIds = [first.rows[49].id, last.rows[0].id, first.rows[0].id];
    const selected = (await db.query(`SELECT public.get_admin_questions_by_ids($1::uuid[]) AS result`, [selectedIds])).rows[0].result;
    assert.equal(selected.requested_count, 3);
    assert.deepEqual(selected.rows.map(row => row.id), selectedIds);

    const missingId = '00000000-0000-0000-0000-000000000000';
    const missing = (await db.query(`SELECT public.get_admin_questions_by_ids($1::uuid[]) AS result`, [[selectedIds[0], missingId]])).rows[0].result;
    assert.equal(missing.requested_count, 2);
    assert.equal(missing.rows.length, 1);

    await assert.rejects(db.query(`SELECT public.get_admin_question_bank_page(0, 201, NULL, NULL, NULL)`), /Page size/);
    await assert.rejects(db.query(`SELECT public.get_admin_questions_by_ids(ARRAY[]::uuid[])`), /Between 1 and 500/);
    await assert.rejects(db.query(`SELECT public.get_admin_questions_by_ids($1::uuid[])`, [[selectedIds[0], selectedIds[0]]]), /unique and non-null/);
    await db.query(`SELECT set_config('test.admin', 'off', false)`);
    await assert.rejects(db.query(`SELECT public.get_admin_question_bank_page(0, 50, NULL, NULL, NULL)`), /AAL2/);
    await assert.rejects(db.query(`SELECT public.get_admin_questions_by_ids($1::uuid[])`, [[selectedIds[0]]]), /AAL2/);
  } finally {
    await db.close();
  }
});

test('administrator Question Bank uses server pages and verified selected-ID assembly', async () => {
  const source = await readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8');
  assert.match(source, /get_admin_question_bank_page/);
  assert.match(source, /page_size_param:\s*QUESTION_BANK_PAGE_SIZE/);
  assert.match(source, /get_admin_questions_by_ids/);
  assert.match(source, /parseSelectedQuestionsResponse/);
  assert.match(source, /Select this page/);
  assert.match(source, /Question Bank pages/);
  assert.doesNotMatch(source, /from\('question_bank'\)\.select\('\*'\)/);
  assert.doesNotMatch(source, /questionBank\.filter\(q => selectedQuestions\.includes/);
});
