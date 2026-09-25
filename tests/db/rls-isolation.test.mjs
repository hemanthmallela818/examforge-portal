import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CORRECT, buildProgress, createTestDb, testUuid } from './harness.mjs';

let h;
let alice;
let bob;
let submittedExam;
let runningExam;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
  alice = await h.createStudent({ studentId: 'RLS-ALICE' });
  bob = await h.createStudent({ studentId: 'RLS-BOB' });
  submittedExam = await h.createExam();
  runningExam = await h.createExam();

  const a = await h.asStudent(alice.id, alice.sessionId);
  const started = await a.value('SELECT public.start_exam_session($1, NULL, NULL)', [submittedExam]);
  await a.query(
    'SELECT public.sync_active_session_progress($1, $2, 1)',
    [submittedExam, buildProgress(started.jumbled_exam_data, DEFAULT_CORRECT)]
  );
  await a.query('SELECT public.submit_exam($1, NULL, 2)', [submittedExam]);
  await a.query('SELECT public.start_exam_session($1, NULL, NULL)', [runningExam]);
});

after(async () => {
  await h?.close();
});

test('a student cannot read another student\'s session, result, review, or roster row', async () => {
  const b = await h.asStudent(bob.id, bob.sessionId);
  assert.deepEqual(await b.rows('SELECT id FROM public.active_sessions'), []);
  assert.deepEqual(await b.rows('SELECT id FROM public.student_results'), []);
  assert.deepEqual(
    await b.rows('SELECT id FROM public.active_sessions WHERE student_id = $1', [alice.studentId]),
    []
  );
  assert.deepEqual(
    await b.rows('SELECT student_id FROM public.student_results WHERE student_id = $1', [alice.studentId]),
    []
  );
  const visibleStudents = await b.rows('SELECT student_id FROM public.students');
  assert.deepEqual(visibleStudents, [{ student_id: bob.studentId }]);
  await assert.rejects(b.query('SELECT * FROM public.student_result_reviews'), /permission denied/);
  await assert.rejects(b.query('SELECT * FROM public.cbt_exam_answers'), /permission denied/);
  assert.deepEqual(await b.rows('SELECT id FROM public.admin_audit_events'), []);

  // Direct writes are not granted to students at all.
  await assert.rejects(
    b.query(`UPDATE public.active_sessions SET user_responses = '{}' WHERE student_id = $1`, [alice.studentId]),
    /permission denied for table active_sessions/
  );
  await assert.rejects(
    b.query('DELETE FROM public.student_results WHERE student_id = $1', [alice.studentId]),
    /permission denied for table student_results/
  );
  await assert.rejects(
    b.query(
      `INSERT INTO public.student_results (exam_id, student_id) VALUES ($1, $2)`,
      [submittedExam, bob.studentId]
    ),
    /permission denied for table student_results/
  );
});

test('a student sees only their own rows, and only from the current session', async () => {
  const a = await h.asStudent(alice.id, alice.sessionId);
  const ownSessions = await a.rows('SELECT exam_id FROM public.active_sessions');
  assert.deepEqual(ownSessions, [{ exam_id: runningExam }]);
  const ownResults = await a.rows('SELECT exam_id, student_id FROM public.student_results');
  assert.deepEqual(ownResults, [{ exam_id: submittedExam, student_id: alice.studentId }]);

  // After a takeover, the replaced device loses access to the live attempt.
  const newSession = testUuid('e');
  await (await h.asStudent(alice.id, newSession)).query('SELECT public.claim_student_session()');
  const stale = await h.asStudent(alice.id, alice.sessionId);
  assert.deepEqual(await stale.rows('SELECT id FROM public.active_sessions'), []);
  const current = await h.asStudent(alice.id, newSession);
  assert.equal((await current.rows('SELECT id FROM public.active_sessions')).length, 1);
});

test('administrators see every student\'s rows', async () => {
  const admin = await h.asAdmin();
  assert.equal(await admin.value('SELECT count(*)::int FROM public.student_results'), 1);
  assert.equal(await admin.value('SELECT count(*)::int FROM public.active_sessions'), 1);
  assert.equal(await admin.value('SELECT count(*)::int FROM public.students'), 2);
});
