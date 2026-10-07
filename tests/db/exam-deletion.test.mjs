import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestDb
} from './harness.mjs';

let h;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
});

after(async () => {
  await h?.close();
});

test('admin can delete pending exam with exact title confirmation', async () => {
  const admin = await h.asAdmin();
  const title = 'Pending Delete Exam';
  const examId = await h.createExam({ title, status: 'PENDING' });

  // Mismatched title rejected
  await assert.rejects(
    admin.query('SELECT public.admin_delete_exam($1::uuid, $2)', [examId, 'Wrong Title']),
    /Exam title confirmation did not match/
  );

  // Exact title succeeds
  const res = await admin.value('SELECT public.admin_delete_exam($1::uuid, $2)', [examId, title]);
  assert.equal(res.deleted, true);
  assert.equal(res.exam_id, examId);

  // Exam row is deleted
  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT count(*)::int FROM public.cbt_exams_raw WHERE id = $1', [examId]), 0);

  // Audit event was recorded with action DELETE_EXAM
  const audit = await su.value(
    `SELECT metadata FROM public.admin_audit_events
     WHERE action = 'DELETE_EXAM' AND target_id = $1`,
    [examId]
  );
  assert.ok(audit);
  assert.equal(audit.title, title);
  assert.equal(audit.status, 'PENDING');
});

test('admin can delete an ACTIVE exam with live student attempts', async () => {
  const admin = await h.asAdmin();
  const title = 'Active Delete Exam';
  const examId = await h.createExam({ title, status: 'ACTIVE' });

  const student = await h.createStudent({ studentId: 'DEL001', name: 'Student Del 1' });
  const s = await h.asStudent(student.id, student.sessionId);
  await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);

  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT count(*)::int FROM public.active_sessions WHERE exam_id = $1', [examId]), 1);

  // Admin deletes the active exam
  const res = await admin.value('SELECT public.admin_delete_exam($1::uuid, $2)', [examId, title]);
  assert.equal(res.deleted, true);
  assert.equal(res.affected.sessions_deleted, 1);

  // Linked session is removed
  assert.equal(await su.value('SELECT count(*)::int FROM public.active_sessions WHERE exam_id = $1', [examId]), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.cbt_exams_raw WHERE id = $1', [examId]), 0);
});

test('admin can delete an ENDED exam with student submissions and answer reviews', async () => {
  const admin = await h.asAdmin();
  const su = await h.asSuperuser();
  const title = 'Ended Delete Exam';
  const examId = await h.createExam({ title, status: 'ACTIVE' });

  const student = await h.createStudent({ studentId: 'DEL002', name: 'Student Del 2' });
  const s = await h.asStudent(student.id, student.sessionId);
  await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s.value('SELECT public.submit_exam($1::uuid, $2::jsonb, NULL, 1)', [examId, '[]']);

  await admin.query(`UPDATE public.cbt_exams SET status = 'ENDED' WHERE id = $1`, [examId]);

  assert.equal(await su.value('SELECT count(*)::int FROM public.student_results WHERE exam_id = $1', [examId]), 1);
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_result_reviews WHERE exam_id = $1', [examId]), 1);

  // Delete ended exam with submissions
  const res = await admin.value('SELECT public.admin_delete_exam($1::uuid, $2)', [examId, title]);
  assert.equal(res.deleted, true);
  assert.equal(res.affected.results_deleted, 1);
  assert.equal(res.affected.reviews_deleted, 1);

  // Results and reviews are cleanly deleted
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_results WHERE exam_id = $1', [examId]), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_result_reviews WHERE exam_id = $1', [examId]), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.cbt_exams_raw WHERE id = $1', [examId]), 0);
});

test('database guards block unauthorized or unauthenticated direct deletion', async () => {
  const title = 'Guarded Delete Exam';
  const examId = await h.createExam({ title, status: 'ACTIVE' });
  const student = await h.createStudent({ studentId: 'DEL003' });
  const s = await h.asStudent(student.id, student.sessionId);

  // Student cannot invoke delete exam RPC
  await assert.rejects(
    s.query('SELECT public.admin_delete_exam($1::uuid, $2)', [examId, title]),
    /Administrator access with MFA \(AAL2\) is required/
  );

  // Anon cannot invoke delete exam RPC
  const anon = await h.asAnon();
  await assert.rejects(
    anon.query('SELECT public.admin_delete_exam($1::uuid, $2)', [examId, title]),
    /permission denied/
  );
});


test('creating an attempt holds a parent row lock until commit so deletion cannot race past it', async () => {
  const examId = await h.createExam();
  const student = await h.createStudent({ studentId: 'DELETELOCK' });
  const s = await h.asStudent(student.id, student.sessionId);
  await s.query('BEGIN');
  try {
    await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
    const su = await h.asSuperuser();
    const locked = await su.value(`SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks
      WHERE relation = 'public.cbt_exams_raw'::regclass
        AND mode = 'RowShareLock' AND granted
    )`);
    assert.equal(locked, true);
  } finally {
    const su = await h.asSuperuser();
    await su.query('ROLLBACK');
  }
});
