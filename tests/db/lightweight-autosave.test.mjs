import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgress, createTestDb } from './harness.mjs';

// #8: autosave and subject-time sync validate against the compact
// active_sessions.response_schema instead of loading the whole paper.
let h;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
});

after(async () => {
  await h?.close();
});

test('response_schema mirrors the paper structure without question content', async () => {
  const student = await h.createStudent({ studentId: 'LW-1' });
  const examId = await h.createExam();
  const s = await h.asStudent(student.id, student.sessionId);
  await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);

  const su = await h.asSuperuser();
  const [row] = await su.rows(
    `SELECT response_schema, jumbled_exam_data,
            public.sanitize_exam_responses(user_responses, response_schema -> 'questions')
              = public.sanitize_exam_responses(user_responses, jumbled_exam_data -> 'questions') AS same_validation
     FROM public.active_sessions WHERE student_id = $1`,
    [student.studentId ?? 'LW-1']
  );
  assert.ok(row.response_schema, 'response_schema is filled by the trigger');
  assert.deepEqual(row.response_schema.subjects, row.jumbled_exam_data.subjects);
  assert.equal(row.response_schema.duration, row.jumbled_exam_data.duration);
  for (const [subject, questions] of Object.entries(row.jumbled_exam_data.questions)) {
    const compact = row.response_schema.questions[subject];
    assert.equal(compact.length, questions.length);
    compact.forEach((entry, index) => {
      assert.equal(entry.type ?? null, questions[index].type ?? null);
      assert.equal(entry.options?.length ?? 0, questions[index].options?.length ?? 0);
      assert.ok((entry.options ?? []).every(option => option === null), 'no option content is copied');
    });
  }
  assert.doesNotMatch(JSON.stringify(row.response_schema), /question_text|questionText|"text"/);
  assert.equal(row.same_validation, true);
});

test('autosave, conflicts and subject time behave the same with the compact schema', async () => {
  const student = await h.createStudent({ studentId: 'LW-2' });
  const examId = await h.createExam();
  const s = await h.asStudent(student.id, student.sessionId);
  const started = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);

  const saved = await s.value('SELECT public.sync_active_session_progress($1, $2, $3)',
    [examId, buildProgress(started.jumbled_exam_data, { 'phy-1': '1' }), 1]);
  assert.equal(saved.success, true);
  assert.equal(saved.version, 2);

  // Stale version: conflict still returns the current server responses.
  const conflict = await s.value('SELECT public.sync_active_session_progress($1, $2, $3)',
    [examId, buildProgress(started.jumbled_exam_data, { 'phy-1': '0' }), 1]);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.version, 2);
  assert.ok(conflict.user_responses, 'conflict response carries the saved answers');

  // Invalid answers are still rejected (MCQ option out of range).
  const bad = structuredClone(buildProgress(started.jumbled_exam_data, {}));
  const firstSubject = Object.keys(bad)[0];
  bad[firstSubject][0] = { selectedOption: 99, status: 'ANSWERED' };
  await assert.rejects(
    s.value('SELECT public.sync_active_session_progress($1, $2, $3)', [examId, bad, 2]),
    /out of range|Invalid MCQ option/
  );

  // Subject time uses the compact subjects/duration.
  const subject = started.jumbled_exam_data.subjects[0];
  const merged = await s.value('SELECT public.sync_exam_subject_time($1, $2)', [examId, { [subject]: 5 }]);
  assert.equal(merged[subject], 5);
  await assert.rejects(
    s.value('SELECT public.sync_exam_subject_time($1, $2)', [examId, { NotASubject: 1 }]),
    /Unknown examination subject/
  );
});
