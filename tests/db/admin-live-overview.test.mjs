import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CORRECT, buildProgress, createTestDb } from './harness.mjs';

let h;
let liveExam;
let pendingExam;
let writer;
let expired;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A', 'B']);
  const submitter = await h.createStudent({ studentId: 'LIVE-SUBMIT', name: 'Asha Submit' });
  writer = await h.createStudent({ studentId: 'LIVE-WRITE' });
  expired = await h.createStudent({ studentId: 'LIVE-EXPIRED' });
  await h.createStudent({ studentId: 'LIVE-OTHER-SECTION', section: 'B' });

  liveExam = await h.createExam({ title: 'Live Physics Test', duration: 90 });
  pendingExam = await h.createExam({ title: 'Pending Test', status: 'PENDING' });

  const s = await h.asStudent(submitter.id, submitter.sessionId);
  const started = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [liveExam]);
  await s.query('SELECT public.sync_active_session_progress($1, $2, 1)', [liveExam, buildProgress(started.jumbled_exam_data, DEFAULT_CORRECT)]);
  await s.query('SELECT public.submit_exam($1, NULL, 2)', [liveExam]);

  const w = await h.asStudent(writer.id, writer.sessionId);
  await w.query('SELECT public.start_exam_session($1, NULL, NULL)', [liveExam]);
  const e = await h.asStudent(expired.id, expired.sessionId);
  await e.query('SELECT public.start_exam_session($1, NULL, NULL)', [liveExam]);
  const su = await h.asSuperuser();
  await su.query(
    `UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval '1 minute'
     WHERE student_id = $1 AND exam_id = $2`,
    ['LIVE-EXPIRED', liveExam]
  );
});

after(async () => {
  await h?.close();
});

test('administrators get live exams, writing / awaiting-finalization totals and recent results', async () => {
  const admin = await h.asAdmin();
  const overview = await admin.value('SELECT public.get_admin_live_overview(5)');

  assert.equal(overview.students_writing, 1);
  assert.equal(overview.awaiting_finalization, 1);
  assert.equal(overview.live_exams.length, 1, 'only ACTIVE exams are listed');
  const [exam] = overview.live_exams;
  assert.equal(exam.id, liveExam);
  assert.equal(exam.title, 'Live Physics Test');
  assert.equal(exam.class, '12');
  assert.equal(exam.section, 'A');
  assert.equal(exam.duration, 90);
  assert.equal(exam.writing, 1);
  assert.equal(exam.awaiting_finalization, 1);
  assert.equal(exam.submitted, 1);
  assert.equal(exam.assigned_students, 3, 'students of other sections are not assigned');
  assert.ok(exam.activated_at, 'the time the exam went live is reported');
  assert.ok(exam.latest_deadline_at, 'the latest live deadline is reported');
  assert.ok(!overview.live_exams.some((row) => row.id === pendingExam));

  assert.equal(overview.recent_results.length, 1);
  const [result] = overview.recent_results;
  assert.equal(result.exam_id, liveExam);
  assert.equal(result.exam_title, 'Live Physics Test');
  assert.equal(result.student_id, 'LIVE-SUBMIT');
  assert.equal(Number(result.total_score), 12);
  assert.equal(JSON.stringify(overview).includes('jumbled_exam_data'), false);
  assert.equal(JSON.stringify(overview).includes('correctAnswer'), false);
});

test('the recent result limit is clamped', async () => {
  const admin = await h.asAdmin();
  assert.equal((await admin.value('SELECT public.get_admin_live_overview(0)')).recent_results.length, 0);
  assert.equal((await admin.value('SELECT public.get_admin_live_overview(-4)')).recent_results.length, 0);
  assert.equal((await admin.value('SELECT public.get_admin_live_overview(NULL)')).recent_results.length, 1);
});

test('students and anon cannot read the live overview', async () => {
  const student = await h.asStudent(writer.id, writer.sessionId);
  await assert.rejects(student.value('SELECT public.get_admin_live_overview(5)'), /Administrator access is required/);

  const anon = await h.asAnon();
  await assert.rejects(anon.value('SELECT public.get_admin_live_overview(5)'), /permission denied/);
});
