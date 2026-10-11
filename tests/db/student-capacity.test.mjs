import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgress, createTestDb, DEFAULT_CORRECT, testUuid } from './harness.mjs';

let h;
before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A', 'B']);
  await h.createClass('11', ['A']);
});
after(async () => { await h?.close(); });

async function attempt(studentId) {
  const student = await h.createStudent({ studentId });
  const examId = await h.createExam();
  const s = await h.asStudent(student.id, student.sessionId);
  const started = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
  return { student, examId, s, started, progress: buildProgress(started.jumbled_exam_data, DEFAULT_CORRECT) };
}

function assertRuntime(runtime, status = 'IN_PROGRESS') {
  assert.equal(runtime.status, status);
  assert.equal(runtime.exam_status, 'ACTIVE');
  assert.equal(runtime.session_owned, true);
  assert.ok(Number.isFinite(Date.parse(runtime.server_now)));
  assert.ok(runtime.time_left >= 0);
}

test('dashboard pages exactly 25 assigned metadata cards in stable order, joining only own summaries', async () => {
  const student = await h.createStudent({ studentId: 'CAP-PAGE' });
  const other = await h.createStudent({ studentId: 'CAP-OTHER' });
  const ids = [];
  for (let index = 0; index < 28; index += 1) ids.push(await h.createExam({ title: `Capacity ${index}` }));
  await h.createExam({ title: 'Wrong class', className: '11' });
  await h.createExam({ title: 'Wrong section', section: 'B' });
  const globalId = await h.createExam({ title: 'Global', className: 'All', section: 'All' });
  const s = await h.asStudent(student.id, student.sessionId);
  await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [ids[27]]);
  await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [ids[26]]);
  await s.value('SELECT public.submit_exam($1, $2, 1, 1)', [ids[26], []]);
  const o = await h.asStudent(other.id, other.sessionId);
  await o.value('SELECT public.start_exam_session($1, NULL, NULL)', [globalId]);
  await o.value('SELECT public.submit_exam($1, $2, 1, 1)', [globalId, []]);
  const first = await s.value('SELECT public.student_dashboard_page()');
  const second = await s.value('SELECT public.student_dashboard_page(1)');
  const empty = await s.value('SELECT public.student_dashboard_page(2)');
  assert.equal(first.exams.length, 25);
  assert.equal(second.exams.length, 4);
  assert.equal(first.has_more, true);
  assert.equal(second.has_more, false);
  assert.deepEqual(empty.exams, []);
  assert.equal(empty.has_more, false);
  assert.deepEqual(first, { ...first, exams: (await s.value('SELECT public.student_dashboard_page(0)')).exams });
  assert.equal(new Set([...first.exams, ...second.exams].map(e => e.id)).size, 29);
  assert.equal(first.exams[0].id, globalId);
  assert.ok(first.exams.every(e => !/Wrong/.test(e.title)));
  assert.equal(first.exams.find(e => e.id === globalId).result, null);
  assert.equal(first.exams.find(e => e.id === globalId).session, null);
  assert.equal(first.exams.find(e => e.id === ids[27]).session.access_generation, 1);
  assert.equal(first.exams.find(e => e.id === ids[26]).result.total_score, 0);
  for (const exam of [...first.exams, ...second.exams]) {
    assert.deepEqual(Object.keys(exam.questions_data).sort(), ['duration', 'marking', 'marksCorrect', 'marksIncorrect', 'subjects', 'totalQuestions']);
    assert.equal(exam.questions_data.totalQuestions, null);
  }
  assert.doesNotMatch(JSON.stringify(first), /correctAnswer|Unit of force|user_responses|jumbled_exam_data/);
  await assert.rejects(s.value('SELECT public.student_dashboard_page(-1)'), /non-negative/);
  await assert.rejects(s.value('SELECT public.student_dashboard_page(NULL)'), /non-negative/);
});

test('runtime/start/save return consistent compact attempt state and old four-argument saves resolve', async () => {
  const { s, examId, started, progress } = await attempt('CAP-RUNTIME');
  assertRuntime(started);
  const before = await s.value('SELECT public.student_exam_runtime($1)', [examId]);
  assertRuntime(before);
  assert.equal(before.deadline_at, started.deadline_at);
  assert.equal(before.version, 1);
  assert.equal(before.result, null);
  assert.doesNotMatch(JSON.stringify(before), /user_responses|questions|jumbled|correctAnswer/);
  const saved = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1)', [examId, progress]);
  assertRuntime(saved);
  assert.equal(saved.version, 2);
  assert.equal(saved.timing_saved, false);
  assert.equal(saved.deadline_at, before.deadline_at);
  const conflict = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1)', [examId, progress]);
  assertRuntime(conflict);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.version, 2);
  assert.deepEqual(conflict.user_responses, progress);
});

test('timing validation is independent and cumulative, preserving answers on invalid timing', async () => {
  const { s, examId, progress, student } = await attempt('CAP-TIMING');
  const first = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, progress, { Physics: 10 }]);
  assert.equal(first.timing_saved, true);
  for (const timing of [{ Unknown: 1 }, { Physics: -1 }, { Physics: 1.5 }, { Physics: 9 }, { Mathematics: 10 }, [], { Physics: 2147483648 }]) {
    const saved = await s.value('SELECT public.sync_active_session_progress($1, $2, $3, 1, $4)', [examId, progress, first.version, timing]);
    assert.equal(saved.timing_saved, false);
    assert.equal(saved.success, true);
    first.version = saved.version;
  }
  const su = await h.asSuperuser();
  const row = (await su.rows('SELECT user_responses, subject_time_seconds, version FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]))[0];
  assert.deepEqual(row.user_responses, progress);
  assert.deepEqual(row.subject_time_seconds, { Physics: 10 });
  await assert.rejects(s.value('SELECT public.sync_exam_subject_time($1, $2, 1)', [examId, { Mathematics: 10 }]), /exceeds the elapsed/);
  const conflict = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, progress, { Physics: 11 }]);
  assert.equal(conflict.timing_saved, false);
  assert.deepEqual(await su.value('SELECT subject_time_seconds FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]), { Physics: 10 });
});

test('ownership takeover blocks new reads and piggyback saves from the old device', async () => {
  const { s, student, examId, progress } = await attempt('CAP-TAKEOVER');
  const replacement = await h.asStudent(student.id, testUuid('e'));
  await replacement.value('SELECT public.claim_student_session()');
  for (const [sql, params] of [
    ['SELECT public.student_dashboard_page()', []],
    ['SELECT public.student_exam_runtime($1)', [examId]],
    ['SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, progress, { Physics: 1 }]]
  ]) await assert.rejects(s.value(sql, params), error => error.code === 'EX001');
  assertRuntime(await replacement.value('SELECT public.student_exam_runtime($1)', [examId]));
});

test('runtime respects assignment, own identity, missing attempts and RPC grants', async () => {
  const student = await h.createStudent({ studentId: 'CAP-ISOLATE' });
  const s = await h.asStudent(student.id, student.sessionId);
  const wrong = await h.createExam({ className: '11' });
  const fresh = await h.createExam();
  const runtime = await s.value('SELECT public.student_exam_runtime($1)', [fresh]);
  assertRuntime(runtime, null);
  assert.equal(runtime.version, null);
  assert.equal(runtime.deadline_at, null);
  await assert.rejects(s.value('SELECT public.student_exam_runtime($1)', [wrong]), e => e.code === 'EX006');
  await assert.rejects(s.value('SELECT public.student_exam_runtime($1)', [testUuid()]), e => e.code === 'EX007');
  const anon = await h.asAnon();
  await assert.rejects(anon.value('SELECT public.student_dashboard_page()'), /permission denied/);
  await assert.rejects(anon.value('SELECT public.student_exam_runtime($1)', [fresh]), /permission denied/);
});

test('terminated and re-granted state is visible while stale generations still cannot save', async () => {
  const { s, student, examId, progress } = await attempt('CAP-GEN');
  await s.value("SELECT public.terminate_exam($1, 'tab_switch', 1)", [examId]);
  const terminated = await s.value('SELECT public.student_exam_runtime($1)', [examId]);
  assertRuntime(terminated, 'TERMINATED');
  assert.equal(terminated.termination_reason, 'tab_switch');
  const admin = await h.asAdmin();
  await admin.value('SELECT public.admin_regrant_exam_access($1)', [student.id + '_' + examId]);
  const regranted = await s.value('SELECT public.student_exam_runtime($1)', [examId]);
  assert.equal(regranted.access_generation, 2);
  assert.equal(regranted.termination_reason, null);
  await assert.rejects(s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, progress, {}]), e => e.code === 'EX015');
  const saved = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 2, $3)', [examId, progress, {}]);
  assert.equal(saved.access_generation, 2);
  assert.equal(saved.timing_saved, true);
});

test('expired retry confirms only the server snapshot and scheduled finalizer still grades it', async () => {
  const { s, student, examId, progress } = await attempt('CAP-EXPIRY');
  await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1)', [examId, progress]);
  const su = await h.asSuperuser();
  await su.query("UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval '10 minutes', started_at = clock_timestamp() - interval '70 minutes' WHERE id = $1", [student.id + '_' + examId]);
  const expired = await s.value('SELECT public.student_exam_runtime($1)', [examId]);
  assert.equal(expired.time_left, 0);
  const lostResponseRetry = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, progress, {}]);
  assert.equal(lostResponseRetry.conflict, true);
  assert.equal(lostResponseRetry.time_left, 0);
  assert.equal(lostResponseRetry.timing_saved, false);
  assert.deepEqual(lostResponseRetry.user_responses, progress);
  await assert.rejects(s.value('SELECT public.sync_active_session_progress($1, $2, 2, 1)', [examId, buildProgress({ questions: {} }, {})]), e => e.code === 'EX008');
  const health = await (await h.asAdmin()).value('SELECT public.admin_operational_health()');
  assert.ok(health.expired_sessions_pending_finalization >= 1);
  assert.ok(health.database_size_bytes > 0);
  assert.ok(health.academic_storage_bytes > 0);
  assert.ok(Date.parse(health.expired_sessions_oldest_deadline_at) <= Date.parse(expired.deadline_at));
  const outcome = await su.value('SELECT public.run_scheduled_session_finalization()');
  assert.ok(outcome.finalized >= 1);
  const finalized = await s.value('SELECT public.student_exam_runtime($1)', [examId]);
  assertRuntime(finalized, 'SUBMITTED');
  assert.equal(finalized.result.total_score, 12);
  assert.equal(finalized.result.max_score, 12);
  assert.equal(finalized.result.correct, 3);
  assert.equal(finalized.version, null);
});

test('expired start retains old grading response and adds runtime fields', async () => {
  const { s, student, examId } = await attempt('CAP-EXPIRED-START');
  const su = await h.asSuperuser();
  await su.query("UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval '1 minute' WHERE id = $1", [student.id + '_' + examId]);
  const resumed = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
  assertRuntime(resumed, 'SUBMITTED');
  assert.equal(resumed.expired, true);
  assert.equal(resumed.time_left, 0);
  assert.equal(resumed.result.totalScore, 0);
});

test('assignment changes reject and roll back a save without weakening answer validation', async () => {
  const { s, student, examId, progress } = await attempt('CAP-ASSIGNMENT');
  const su = await h.asSuperuser();
  const invalid = structuredClone(progress);
  invalid.Physics[0].selectedOption = '999';
  await assert.rejects(s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, invalid, { Physics: 5 }]), /out of range|Invalid MCQ option/);
  assert.deepEqual(await su.value('SELECT subject_time_seconds FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]), {});
  await su.query("UPDATE public.students SET class = '11' WHERE id = $1", [student.id]);
  await assert.rejects(s.value('SELECT public.student_exam_runtime($1)', [examId]), e => e.code === 'EX006');
  await assert.rejects(s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1, $3)', [examId, progress, { Physics: 5 }]), e => e.code === 'EX006');
  const row = (await su.rows('SELECT version, subject_time_seconds FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]))[0];
  assert.equal(row.version, 1);
  assert.deepEqual(row.subject_time_seconds, {});
});

test('missing class or section never grants access to restricted exams', async () => {
  const student = await h.createStudent({ studentId: 'CAP-NULL-ASSIGNMENT' });
  const s = await h.asStudent(student.id, student.sessionId);
  const restricted = await h.createExam();
  const global = await h.createExam({ className: 'All', section: 'All' });
  const su = await h.asSuperuser();
  for (const [className, section] of [[null, 'A'], ['12', null], [null, null]]) {
    await su.query('UPDATE public.students SET class = $2, section = $3 WHERE id = $1', [student.id, className, section]);
    await assert.rejects(s.value('SELECT public.student_exam_runtime($1)', [restricted]), e => e.code === 'EX006');
    await assert.rejects(s.value('SELECT public.start_exam_session($1, NULL, NULL)', [restricted]), e => e.code === 'EX006');
    assert.equal(await su.value('SELECT count(*)::int FROM public.active_sessions WHERE id = $1', [student.id + '_' + restricted]), 0);
    const page = await s.value('SELECT public.student_dashboard_page()');
    assert.equal(page.exams.some(exam => exam.id === restricted), false);
    assertRuntime(await s.value('SELECT public.student_exam_runtime($1)', [global]), null);
  }
});

test('internal start and uncommitted submit reject NULL assignments while committed results remain idempotent', async () => {
  const { s, student, examId, progress } = await attempt('CAP-NULL-SUBMIT');
  const committed = await h.createExam();
  const fresh = await h.createExam();
  await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [committed]);
  const result = await s.value('SELECT public.submit_exam($1, $2, 1, 1)', [committed, []]);
  await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1)', [examId, progress]);
  const su = await h.asSuperuser();
  for (const [className, section] of [[null, 'A'], ['12', null], [null, null]]) {
    await su.query('UPDATE public.students SET class = $2, section = $3 WHERE id = $1', [student.id, className, section]);
    await assert.rejects(s.value('SELECT public.submit_exam($1, $2, 2, 1)', [examId, []]), e => e.code === 'EX006');
    assert.deepEqual(await s.value('SELECT public.submit_exam($1, $2, 1, 1)', [committed, []]), result);
    // Private helpers are callable only by trusted service contexts; retain this student's JWT for their assignment check.
    await s.query('SELECT 1');
    await h.db.exec('SET ROLE service_role');
    await assert.rejects(h.db.query('SELECT public.start_exam_session_internal($1, NULL, NULL)', [fresh]), e => e.code === 'EX006');
    assert.equal(await su.value('SELECT count(*)::int FROM public.student_results WHERE exam_id = $1', [examId]), 0);
    assert.equal(await su.value('SELECT version FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]), 2);
  }
});

test('delayed versioned submission rejects a newer snapshot before expiry and grades it after expiry', async () => {
  const { s, student, examId, started } = await attempt('CAP-SUBMIT-VERSION');
  const first = buildProgress(started.jumbled_exam_data, { 'phy-1': '1' });
  const latest = buildProgress(started.jumbled_exam_data, { 'phy-1': '1', 'math-1': '2.5' });
  const confirmed = await s.value('SELECT public.sync_active_session_progress($1, $2, 1, 1)', [examId, first]);
  const newer = await s.value('SELECT public.sync_active_session_progress($1, $2, 2, 1)', [examId, latest]);
  await assert.rejects(s.value('SELECT public.submit_exam($1, NULL, $2, 1)', [examId, confirmed.version]), e => e.code === 'EX013');
  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_results WHERE exam_id = $1', [examId]), 0);
  assert.equal(await su.value('SELECT version FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]), newer.version);
  assert.deepEqual(await su.value('SELECT user_responses FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]), latest);
  await su.query("UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval '1 minute' WHERE id = $1", [student.id + '_' + examId]);
  const result = await s.value('SELECT public.submit_exam($1, NULL, $2, 1)', [examId, confirmed.version]);
  assert.equal(result.totalScore, 8);
  assert.equal(result.correct, 2);
  assert.deepEqual(await s.value('SELECT public.submit_exam($1, NULL, 1, 1)', [examId]), result);
});
