import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  MAX_PDF_RESULT_ROWS,
  buildLeaderboard,
  buildLeaderboardCsv,
  calculateResultAnalytics,
  createLeaderboardPdfDocument,
  safeDownloadName,
  validatePdfExport
} from '../src/resultExportLogic.js';

const records = [
  { studentId: 'S2', studentName: 'Second', totalScore: '2', maxScore: '100', subjectScores: { Physics: '-1' } },
  { studentId: 'S1', studentName: 'First', totalScore: '10', maxScore: '100', subjectScores: { Physics: '4' } },
  { studentId: 'S3', studentName: 'Third', totalScore: '2', maxScore: '100', subjectScores: { Physics: '-1' } }
];

test('numeric database strings are ranked numerically with competition ties', () => {
  const ranked = buildLeaderboard(records, ['Physics']);
  assert.deepEqual(ranked.map(row => [row.studentId, row.totalRank, row.subjectRanks.Physics]), [
    ['S1', 1, 1], ['S2', 2, 2], ['S3', 2, 2]
  ]);
});

test('analytics add numeric strings rather than concatenating them', () => {
  const analytics = calculateResultAnalytics(records, ['Physics']);
  assert.equal(analytics.averageScore, 14 / 3);
  assert.equal(analytics.highestScore, 10);
  assert.equal(analytics.lowestScore, 2);
  assert.equal(analytics.subjectAverages[0].score, 2 / 3);
});

test('zero maximum scores are excluded from percentage distribution', () => {
  const analytics = calculateResultAnalytics([{ studentId: 'S1', studentName: 'Student', totalScore: 0, maxScore: 0, subjectScores: {} }]);
  assert.equal(analytics.excludedFromDistribution, 1);
  assert.equal(analytics.distribution.reduce((sum, range) => sum + range.count, 0), 0);
});

test('CSV preserves negative values as numbers and neutralizes formula text', () => {
  const csv = buildLeaderboardCsv([
    { studentId: '=CMD()', studentName: '  +SUM(1,2)', totalScore: -1, maxScore: 4, subjectScores: { Physics: -1 } }
  ], ['Physics']);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"'\+SUM\(1,2\)"/);
  assert.match(csv, /"'=CMD\(\)"/);
  assert.match(csv, /,-1,1,-1,4\r\n$/);
  assert.doesNotMatch(csv, /"'-1"/);
});

test('CSV uses CRLF rows, quotes embedded quotes, and flattens embedded newlines', () => {
  const csv = buildLeaderboardCsv([{ studentId: 'S"1', studentName: 'Line 1\nLine 2', totalScore: 4, maxScore: 4, subjectScores: {} }]);
  assert.match(csv, /"Line 1 Line 2"/);
  assert.match(csv, /"S""1"/);
  assert.doesNotMatch(csv.replace(/\r\n/g, ''), /[\r\n]/);
});

test('invalid or duplicate result records fail closed', () => {
  assert.throws(() => buildLeaderboard([{ studentId: 'S1', studentName: 'One', totalScore: 'NaN', maxScore: 4 }]), /Total score/);
  assert.throws(() => buildLeaderboard([
    { studentId: 'S1', studentName: 'One', totalScore: 1, maxScore: 4 },
    { studentId: 'S1', studentName: 'Duplicate', totalScore: 2, maxScore: 4 }
  ]), /Duplicate result/);
});

test('download filenames are Windows-safe, bounded, and avoid reserved names', () => {
  assert.equal(safeDownloadName('CON'), '_CON');
  assert.equal(safeDownloadName(' Exam:<1>. '), 'Exam__1_');
  assert.equal(safeDownloadName('x'.repeat(150)).length, 100);
});

test('PDF eligibility fails clearly for Unicode and oversized cohorts', () => {
  assert.match(validatePdfExport([{ studentId: 'S1', studentName: 'विद्यार्थी', totalScore: 4, maxScore: 4 }], [], 'Exam').error, /Unicode/);
  const oversized = Array.from({ length: MAX_PDF_RESULT_ROWS + 1 }, (_, index) => ({
    studentId: `S${index}`, studentName: `Student ${index}`, totalScore: 0, maxScore: 4
  }));
  assert.match(validatePdfExport(oversized, [], 'Exam').error, /limited/);
});

test('the production PDF renderer paginates large tables with repeated headers and page footers', () => {
  const results = Array.from({ length: 80 }, (_, index) => ({
    studentId: `S${index + 1}`,
    studentName: index === 4 ? 'A Student With A Long Name That Must Wrap Without Clipping' : `Student ${index + 1}`,
    totalScore: 300 - index,
    maxScore: 300,
    subjectScores: { Physics: 100 - (index % 10), Chemistry: 90, Mathematics: 80 }
  }));
  const { doc, filename } = createLeaderboardPdfDocument({
    PdfConstructor: jsPDF,
    autoTable,
    results,
    subjects: ['Physics', 'Chemistry', 'Mathematics'],
    examTitle: 'Long Production Examination Title That Must Wrap Safely Across the Available Page Width',
    generatedAt: new Date('2026-09-11T10:00:00Z')
  });
  assert.ok(doc.getNumberOfPages() > 1);
  assert.equal(filename, 'Long Production Examination Title That Must Wrap Safely Across the Available Page Width_Leaderboard.pdf');
  assert.ok(doc.output('arraybuffer').byteLength > 50_000);
});

test('result export authorization is AAL2-only, count-verified, and auditable', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;
      CREATE FUNCTION public.is_admin_aal2() RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT current_setting('test.admin', true) = 'on' $$;
      CREATE TABLE public.cbt_exams_raw (id uuid PRIMARY KEY, title text NOT NULL);
      CREATE TABLE public.student_results (exam_id text NOT NULL, student_id text NOT NULL);
      CREATE TABLE public.admin_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_user_id uuid NOT NULL,
        action text NOT NULL,
        target_type text NOT NULL,
        target_id text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO public.cbt_exams_raw VALUES ('22222222-2222-2222-2222-222222222222', 'Audited Exam');
      INSERT INTO public.student_results VALUES
        ('22222222-2222-2222-2222-222222222222', 'S1'),
        ('22222222-2222-2222-2222-222222222222', 'S2');
      SELECT set_config('test.admin', 'on', false);
    `);
    const migration = await readFile(new URL('../supabase/migrations/20260910280000_stage17_audited_result_exports.sql', import.meta.url), 'utf8');
    await db.exec(migration);

    const authorized = await db.query(`SELECT public.record_result_export(
      '22222222-2222-2222-2222-222222222222', 'csv', 2
    ) AS result`);
    assert.equal(authorized.rows[0].result.authorized, true);
    assert.equal(authorized.rows[0].result.result_count, 2);

    const audit = await db.query(`SELECT action, target_id, metadata FROM public.admin_audit_events`);
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].action, 'RESULT_EXPORT_REQUESTED');
    assert.equal(audit.rows[0].metadata.format, 'CSV');
    assert.equal(audit.rows[0].metadata.result_count, 2);
    assert.equal(JSON.stringify(audit.rows[0].metadata).includes('student'), false);

    await assert.rejects(
      db.query(`SELECT public.record_result_export('22222222-2222-2222-2222-222222222222', 'PDF', 1)`),
      /Result set changed/
    );
    await assert.rejects(
      db.query(`SELECT public.record_result_export('22222222-2222-2222-2222-222222222222', 'XLS', 2)`),
      /CSV or PDF/
    );
    await db.query(`SELECT set_config('test.admin', 'off', false)`);
    await assert.rejects(
      db.query(`SELECT public.record_result_export('22222222-2222-2222-2222-222222222222', 'CSV', 2)`),
      /AAL2/
    );
    assert.equal((await db.query(`SELECT count(*)::integer AS count FROM public.admin_audit_events`)).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('administrator export controls fail closed and suppress duplicate downloads', async () => {
  const source = await readFile(new URL('../src/components/AdminDashboard.jsx', import.meta.url), 'utf8');
  assert.match(source, /record_result_export/);
  assert.match(source, /expected_result_count_param:\s*resultCount/);
  assert.match(source, /disabled=\{exportUnavailable\}/);
  assert.match(source, /disabled=\{isDownloadingPDF \|\| exportUnavailable\}/);
  assert.match(source, /csvDownloadInFlight\.current/);
  assert.match(source, /pdfDownloadInFlight\.current/);
  assert.match(source, /Download CSV/);
});
