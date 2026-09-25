import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CORRECT,
  buildProgress,
  buildSubmission,
  createTestDb,
  testUuid
} from './harness.mjs';

let h;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A', 'B']);
});

after(async () => {
  await h?.close();
});

async function resultRowCount(studentId, examId) {
  const su = await h.asSuperuser();
  return su.value(
    'SELECT count(*)::int FROM public.student_results WHERE student_id = $1 AND exam_id = $2',
    [studentId, examId]
  );
}

async function startExam(student, examId) {
  const s = await h.asStudent(student.id, student.sessionId);
  return s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
}

async function autosave(student, examId, progress, version) {
  const s = await h.asStudent(student.id, student.sessionId);
  return s.value('SELECT public.sync_active_session_progress($1, $2, $3)', [examId, progress, version]);
}

test('versioned submit grades the server snapshot and ignores the client payload', async () => {
  const student = await h.createStudent({ studentId: 'SUB-V1' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);
  assert.equal(started.version, 1);
  // The public paper handed to the student never contains answers.
  assert.doesNotMatch(JSON.stringify(started.jumbled_exam_data), /correctAnswer|correct_answer/);

  // Server snapshot: phy-1 correct, phy-2 wrong, math-1 unanswered.
  const saved = await autosave(
    student, examId,
    buildProgress(started.jumbled_exam_data, { 'phy-1': '1', 'phy-2': '0' }),
    1
  );
  assert.equal(saved.success, true);
  assert.equal(saved.version, 2);

  // Client claims everything correct; with expected_version the payload is ignored.
  const s = await h.asStudent(student.id, student.sessionId);
  const result = await s.value(
    'SELECT public.submit_exam($1, $2, $3)',
    [examId, buildSubmission(DEFAULT_CORRECT), 2]
  );
  assert.deepEqual(result, {
    totalScore: 3,
    maxScore: 12,
    correct: 1,
    incorrect: 1,
    unattempted: 1,
    subjectScores: { Physics: 3, Mathematics: 0 }
  });

  const su = await h.asSuperuser();
  assert.equal(
    await su.value('SELECT count(*)::int FROM public.active_sessions WHERE exam_id = $1', [examId]),
    0,
    'submission removes the active session'
  );
  const review = await su.value(
    `SELECT v.response_snapshot FROM public.student_result_reviews v
     JOIN public.student_results r ON r.id = v.result_id
     WHERE r.student_id = $1 AND r.exam_id = $2`,
    [student.studentId, examId]
  );
  assert.ok(review, 'a review snapshot is captured for the committed result');
});

test('legacy two-argument submit still grades the client payload', async () => {
  const student = await h.createStudent({ studentId: 'SUB-L1' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);
  await autosave(student, examId, buildProgress(started.jumbled_exam_data, { 'phy-1': '0' }), 1);

  const s = await h.asStudent(student.id, student.sessionId);
  const result = await s.value(
    'SELECT public.submit_exam($1, $2)',
    [examId, buildSubmission(DEFAULT_CORRECT)]
  );
  assert.equal(result.totalScore, 12);
  assert.equal(result.correct, 3);
  assert.equal(result.unattempted, 0);
  assert.deepEqual(result.subjectScores, { Physics: 8, Mathematics: 4 });
});

test('legacy submit with an empty payload falls back to the server snapshot', async () => {
  const student = await h.createStudent({ studentId: 'SUB-L2' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);
  await autosave(student, examId, buildProgress(started.jumbled_exam_data, { 'math-1': '2.50' }), 1);

  const s = await h.asStudent(student.id, student.sessionId);
  const result = await s.value(`SELECT public.submit_exam($1, '[]'::jsonb)`, [examId]);
  assert.equal(result.correct, 1, 'numerical answers compare numerically');
  assert.equal(result.totalScore, 4);
  assert.equal(result.unattempted, 2);
});

test('duplicate submit returns the same result and keeps exactly one result row', async () => {
  const student = await h.createStudent({ studentId: 'SUB-D1' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);
  await autosave(student, examId, buildProgress(started.jumbled_exam_data, { 'phy-2': '2' }), 1);

  const s = await h.asStudent(student.id, student.sessionId);
  const first = await s.value('SELECT public.submit_exam($1, NULL, 2)', [examId]);
  const second = await s.value('SELECT public.submit_exam($1, NULL, 2)', [examId]);
  const legacyRetry = await s.value(
    'SELECT public.submit_exam($1, $2)',
    [examId, buildSubmission(DEFAULT_CORRECT)]
  );
  assert.deepEqual(second, first);
  assert.deepEqual(legacyRetry, first, 'a retry cannot regrade a committed result');
  assert.equal(await resultRowCount(student.studentId, examId), 1);

  await assert.rejects(
    s.query('SELECT public.start_exam_session($1, NULL, NULL)', [examId]),
    /already been submitted/
  );
});

test('takeover after commit still returns the committed result to the old device', async () => {
  const student = await h.createStudent({ studentId: 'SUB-T1' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);
  await autosave(student, examId, buildProgress(started.jumbled_exam_data, DEFAULT_CORRECT), 1);

  const oldDevice = await h.asStudent(student.id, student.sessionId);
  const committed = await oldDevice.value('SELECT public.submit_exam($1, NULL, 2)', [examId]);
  assert.equal(committed.totalScore, 12);

  // A second device signs in and takes over the student session.
  const newSession = testUuid('e');
  const newDevice = await h.asStudent(student.id, newSession);
  const claim = await newDevice.value('SELECT public.claim_student_session()');
  assert.equal(claim.replaced_existing_session, true);

  // The old device's response was lost; its retry must return the committed result.
  const stale = await h.asStudent(student.id, student.sessionId);
  const recovered = await stale.value('SELECT public.submit_exam($1, NULL, 2)', [examId]);
  assert.deepEqual(recovered, committed);
  assert.equal(await resultRowCount(student.studentId, examId), 1);
});

test('a replaced session without a committed result is rejected everywhere', async () => {
  const student = await h.createStudent({ studentId: 'SUB-R1' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);

  const newSession = testUuid('e');
  await (await h.asStudent(student.id, newSession)).query('SELECT public.claim_student_session()');

  const stale = await h.asStudent(student.id, student.sessionId);
  await assert.rejects(
    stale.query('SELECT public.submit_exam($1, $2, 1)', [examId, buildSubmission(DEFAULT_CORRECT)]),
    /replaced or is no longer active/
  );
  await assert.rejects(
    stale.query('SELECT public.submit_exam($1, $2)', [examId, buildSubmission(DEFAULT_CORRECT)]),
    /replaced or is no longer active/
  );
  await assert.rejects(
    stale.query(
      'SELECT public.sync_active_session_progress($1, $2, 1)',
      [examId, buildProgress(started.jumbled_exam_data, DEFAULT_CORRECT)]
    ),
    /replaced or is no longer active/
  );
  await assert.rejects(
    stale.query('SELECT public.start_exam_session($1, NULL, NULL)', [examId]),
    /replaced or is no longer active/
  );
  assert.equal(await resultRowCount(student.studentId, examId), 0);

  // The new device resumes the same attempt (same version, same paper).
  const current = await h.asStudent(student.id, newSession);
  const resumed = await current.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
  assert.equal(resumed.version, 1);
  assert.deepEqual(resumed.jumbled_exam_data, started.jumbled_exam_data);
});

test('sync_active_session_progress: version conflict returns current responses and cannot overwrite', async () => {
  const student = await h.createStudent({ studentId: 'SYNC-1' });
  const examId = await h.createExam();
  const started = await startExam(student, examId);
  const paper = started.jumbled_exam_data;

  const tabA = buildProgress(paper, { 'phy-1': '1' });
  const savedA = await autosave(student, examId, tabA, 1);
  assert.deepEqual(
    { success: savedA.success, conflict: savedA.conflict, version: savedA.version },
    { success: true, conflict: false, version: 2 }
  );

  // A stale tab still believes version 1 is current.
  const tabB = buildProgress(paper, { 'phy-1': '3', 'phy-2': '3', 'math-1': '9' });
  const conflict = await autosave(student, examId, tabB, 1);
  assert.equal(conflict.success, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.version, 2);
  assert.deepEqual(conflict.user_responses, tabA);

  // A far-future version is also a conflict, not an overwrite.
  const future = await autosave(student, examId, tabB, 99);
  assert.equal(future.conflict, true);

  const su = await h.asSuperuser();
  const row = (await su.rows(
    'SELECT version, user_responses FROM public.active_sessions WHERE exam_id = $1',
    [examId]
  ))[0];
  assert.equal(row.version, 2);
  assert.deepEqual(row.user_responses, tabA, 'stale write did not overwrite the snapshot');

  // Resuming reports the server snapshot and version.
  const resumed = await startExam(student, examId);
  assert.equal(resumed.version, 2);
  assert.deepEqual(resumed.user_responses, tabA);

  // Invalid payloads are rejected by the server-side sanitizer.
  const s = await h.asStudent(student.id, student.sessionId);
  await assert.rejects(
    s.query('SELECT public.sync_active_session_progress($1, $2, 2)', [examId, { Biology: [] }]),
    /Unknown response subject/
  );
  await assert.rejects(
    s.query('SELECT public.sync_active_session_progress($1, $2, 0)', [examId, tabA]),
    /positive expected session version/
  );

  // After the deadline, progress is no longer accepted.
  await su.query(
    `UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval '1 second' WHERE exam_id = $1`,
    [examId]
  );
  await assert.rejects(autosave(student, examId, tabB, 2), /time has expired/);
});

test('students are confined to their own class/section assignment', async () => {
  const student = await h.createStudent({ studentId: 'SUB-SEC', section: 'B' });
  const examId = await h.createExam({ section: 'A' });
  await assert.rejects(startExam(student, examId), /not assigned to you/);
});
