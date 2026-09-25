import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { parsePagedCollectionResponse } from '../src/paginatedQuery.js';
import { adminSource } from './support/adminSource.mjs';

test('paged collection responses are validated before replacing confirmed UI data', () => {
  assert.deepEqual(parsePagedCollectionResponse({ page: 1, page_size: 2, total: 3, rows: [{ id: 3 }] }, {
    expectedPage: 1,
    expectedPageSize: 2
  }), { page: 1, pageSize: 2, total: 3, rows: [{ id: 3 }] });
  assert.throws(() => parsePagedCollectionResponse({ page: 0, page_size: 2, total: 3, rows: [] }, {
    expectedPage: 1,
    expectedPageSize: 2
  }), /unexpected page number/);
  assert.throws(() => parsePagedCollectionResponse({ page: 0, page_size: 2, total: 1, rows: [{}, {}] }, {
    expectedPage: 0,
    expectedPageSize: 2
  }), /more rows/);
});

test('student roster RPC is AAL2-only, bounded, filterable, and correctly paginated', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE FUNCTION public.is_admin_aal2() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT current_setting('test.admin', true) = 'on' $$;
      CREATE TABLE public.students (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id text NOT NULL UNIQUE,
        name text NOT NULL,
        class text,
        section text,
        archived_at timestamptz,
        archive_reason text,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO public.students (student_id, name, class, section)
      SELECT
        'STU-' || lpad(number::text, 4, '0'),
        'Student ' || number,
        CASE WHEN number % 2 = 0 THEN '12' ELSE '11' END,
        CASE WHEN number % 3 = 0 THEN 'A' ELSE 'B' END
      FROM generate_series(1, 205) AS number;
      INSERT INTO public.students (student_id, name, class, section)
      VALUES ('SPECIAL-1', 'Percent % Student', '12', 'A');
      SELECT set_config('test.admin', 'on', false);
    `);
    const migration = await readFile(new URL('../supabase/migrations/20260910290000_stage19_paginated_student_roster.sql', import.meta.url), 'utf8');
    await db.exec(migration);

    const first = (await db.query(`SELECT public.get_admin_student_roster_page(0, 100, NULL, NULL, NULL) AS page`)).rows[0].page;
    assert.equal(first.total, 206);
    assert.equal(first.rows.length, 100);
    assert.equal(first.rows[0].student_id, 'SPECIAL-1');

    const last = (await db.query(`SELECT public.get_admin_student_roster_page(2, 100, NULL, NULL, NULL) AS page`)).rows[0].page;
    assert.equal(last.rows.length, 6);

    const filtered = (await db.query(`SELECT public.get_admin_student_roster_page(0, 100, 'student 6', '12', 'A') AS page`)).rows[0].page;
    assert.ok(filtered.total > 0);
    assert.ok(filtered.rows.every(row => row.class === '12' && row.section === 'A' && row.name.toLowerCase().includes('student 6')));

    const literalWildcard = (await db.query(`SELECT public.get_admin_student_roster_page(0, 100, '%', NULL, NULL) AS page`)).rows[0].page;
    assert.equal(literalWildcard.total, 1);
    assert.equal(literalWildcard.rows[0].student_id, 'SPECIAL-1');

    await assert.rejects(db.query(`SELECT public.get_admin_student_roster_page(0, 201, NULL, NULL, NULL)`), /Page size/);
    await assert.rejects(db.query(`SELECT public.get_admin_student_roster_page(-1, 100, NULL, NULL, NULL)`), /Page number/);
    await db.query(`SELECT set_config('test.admin', 'off', false)`);
    await assert.rejects(db.query(`SELECT public.get_admin_student_roster_page(0, 100, NULL, NULL, NULL)`), /AAL2/);
  } finally {
    await db.close();
  }
});

test('administrator roster uses server paging and disables stale-page actions', async () => {
  const source = await adminSource();
  assert.match(source, /get_admin_student_roster_page/);
  assert.match(source, /page_size_param:\s*STUDENT_ROSTER_PAGE_SIZE/);
  assert.match(source, /search_param:\s*query\.search \|\| null/);
  assert.match(source, /parsePagedCollectionResponse/);
  assert.match(source, /fieldset disabled=\{rosterActionsDisabled\}/);
  assert.match(source, /Student roster pages/);
  assert.match(source, /setStudentRosterPage\(0\)/);
  assert.doesNotMatch(source, /from\('students'\)\.select\('\*'\)/);
});
