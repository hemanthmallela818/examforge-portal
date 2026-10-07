import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_ID,
  buildProgress,
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

test('immediate termination marks session as TERMINATED without creating student_results', async () => {
  const su = await h.asSuperuser();
  const examId = await h.createExam({ status: 'ACTIVE' });
  const student = await h.createStudent({ studentId: 'TERM001', name: 'Student Term 1' });
  const s = await h.asStudent(student.id, student.sessionId);

  const started = await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  assert.equal(started.access_generation, 1);

  // Sync some progress first
  const answers = { 'phy-1': '1' };
  const progress = buildProgress(started.jumbled_exam_data, answers);
  await s.value('SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1, 1)', [examId, progress]);

  // Terminate exam due to fullscreen_exit
  const termRes = await s.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'fullscreen_exit']);
  assert.equal(termRes.terminated, true);

  // Check active_sessions has TERMINATED status, reason, timestamp, and preserved deadline
  const sessionRow = (await su.rows(
    'SELECT status, termination_reason, terminated_at, access_generation, deadline_at FROM public.active_sessions WHERE student_id = $1 AND exam_id = $2',
    [student.studentId, examId]
  ))[0];
  assert.equal(sessionRow.status, 'TERMINATED');
  assert.equal(sessionRow.termination_reason, 'fullscreen_exit');
  assert.ok(sessionRow.terminated_at);
  assert.equal(sessionRow.access_generation, 1);
  assert.ok(sessionRow.deadline_at);

  // Ensure NO student_results row was created!
  const resultsCount = await su.value(
    'SELECT count(*)::int FROM public.student_results WHERE student_id = $1 AND exam_id = $2',
    [student.studentId, examId]
  );
  assert.equal(resultsCount, 0);
});

test('student mutations are blocked while session is terminated', async () => {
  const examId = await h.createExam({ status: 'ACTIVE' });
  const student = await h.createStudent({ studentId: 'TERM002', name: 'Student Term 2' });
  const s = await h.asStudent(student.id, student.sessionId);

  const started = await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'tab_switch']);

  const progress = buildProgress(started.jumbled_exam_data, { 'phy-1': '2' });

  // Progress sync blocked
  await assert.rejects(
    s.query('SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1, 1)', [examId, progress]),
    /Active session is terminated/
  );

  // Subject time sync blocked
  await assert.rejects(
    s.query('SELECT public.sync_exam_subject_time($1::uuid, $2::jsonb, 1)', [examId, '{"Physics": 10}']),
    /Active session is terminated/
  );

  // Submit blocked
  await assert.rejects(
    s.query('SELECT public.submit_exam($1::uuid, $2::jsonb, 1, 1)', [examId, '[]']),
    /Cannot submit a terminated exam/
  );
});

test('admin can re-grant exam access, rotating generation and preserving deadline', async () => {
  const su = await h.asSuperuser();
  const admin = await h.asAdmin();
  const examId = await h.createExam({ status: 'ACTIVE' });
  const student = await h.createStudent({ studentId: 'TERM003', name: 'Student Term 3' });
  const s = await h.asStudent(student.id, student.sessionId);

  const started = await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  const originalDeadline = (await su.rows(
    'SELECT id, deadline_at FROM public.active_sessions WHERE student_id = $1 AND exam_id = $2',
    [student.studentId, examId]
  ))[0];

  await s.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'escape_key']);

  // Admin re-grants access
  const regrantRes = await admin.value('SELECT public.admin_regrant_exam_access($1)', [originalDeadline.id]);
  assert.equal(regrantRes.success, true);
  assert.equal(regrantRes.access_generation, 2);

  // Session state is IN_PROGRESS again, reason cleared, deadline preserved, generation incremented
  const updatedSession = (await su.rows(
    'SELECT status, termination_reason, terminated_at, access_generation, deadline_at FROM public.active_sessions WHERE id = $1',
    [originalDeadline.id]
  ))[0];
  assert.equal(updatedSession.status, 'IN_PROGRESS');
  assert.equal(updatedSession.termination_reason, null);
  assert.equal(updatedSession.terminated_at, null);
  assert.equal(updatedSession.access_generation, 2);
  assert.equal(new Date(updatedSession.deadline_at).getTime(), new Date(originalDeadline.deadline_at).getTime());

  // Check audit log
  const audit = (await su.rows(
    `SELECT action, actor_user_id, target_type, metadata FROM public.admin_audit_events
     WHERE action = 'REGRANT_EXAM_ACCESS' AND target_id = $1`,
    [originalDeadline.id]
  ))[0];
  assert.ok(audit);
  assert.equal(audit.actor_user_id, ADMIN_ID);
  assert.equal(audit.metadata.new_generation, 2);
  assert.equal(audit.metadata.student_id, student.studentId);

  // Student mutations with stale generation (1) are rejected
  const progress = buildProgress(started.jumbled_exam_data, { 'phy-1': '1' });
  await assert.rejects(
    s.query('SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1, 1)', [examId, progress]),
    /Session access generation mismatch/
  );

  // Student mutations with new generation (2) succeed!
  const syncRes = await s.value('SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1, 2)', [examId, progress]);
  assert.equal(syncRes.success, true);
  assert.equal(syncRes.access_generation, 2);

  // Repeat cycle: terminate again, re-grant again
  await s.value('SELECT public.terminate_exam($1::uuid, $2, 2)', [examId, 'window_blur']);
  const secondRegrant = await admin.value('SELECT public.admin_regrant_exam_access($1)', [originalDeadline.id]);
  assert.equal(secondRegrant.access_generation, 3);
});

test('expired terminated session is finalized at original deadline with termination metadata', async () => {
  const su = await h.asSuperuser();
  const examId = await h.createExam({ status: 'ACTIVE' });
  const student = await h.createStudent({ studentId: 'TERM004', name: 'Student Term 4' });
  const s = await h.asStudent(student.id, student.sessionId);

  const started = await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  const progress = buildProgress(started.jumbled_exam_data, { 'phy-1': '1', 'math-1': '2.5' });
  await s.value('SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1, 1)', [examId, progress]);

  await s.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'hidden_tab']);

  // Move deadline into the past (outside 120s grace period)
  await su.query(
    `UPDATE public.active_sessions
     SET deadline_at = clock_timestamp() - interval '10 minutes',
         started_at = clock_timestamp() - interval '70 minutes'
     WHERE student_id = $1 AND exam_id = $2`,
    [student.studentId, examId]
  );

  // Run scheduler finalizer
  const outcome = await su.value('SELECT public.run_scheduled_session_finalization()');
  assert.equal(outcome.finalized >= 1, true);

  // Session row removed
  const sessionCount = await su.value(
    'SELECT count(*)::int FROM public.active_sessions WHERE student_id = $1 AND exam_id = $2',
    [student.studentId, examId]
  );
  assert.equal(sessionCount, 0);

  // Result row exists with termination flags preserved
  const resultRow = (await su.rows(
    'SELECT total_score, was_terminated, termination_reason, terminated_at FROM public.student_results WHERE student_id = $1 AND exam_id = $2',
    [student.studentId, examId]
  ))[0];
  assert.ok(resultRow);
  assert.equal(resultRow.was_terminated, true);
  assert.equal(resultRow.termination_reason, 'hidden_tab');
  assert.ok(resultRow.terminated_at);
  assert.equal(Number(resultRow.total_score), 8); // Phy-1 and Math-1 answered correctly
});

test('admin cannot re-grant access if session has expired or been finalized', async () => {
  const su = await h.asSuperuser();
  const admin = await h.asAdmin();
  const examId = await h.createExam({ status: 'ACTIVE' });
  const student = await h.createStudent({ studentId: 'TERM005', name: 'Student Term 5' });
  const s = await h.asStudent(student.id, student.sessionId);

  await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'fullscreen_exit']);

  const session = (await su.rows(
    'SELECT id FROM public.active_sessions WHERE student_id = $1 AND exam_id = $2',
    [student.studentId, examId]
  ))[0];

  // Set deadline to past
  await su.query(
    'UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval \'1 minute\' WHERE id = $1',
    [session.id]
  );

  await assert.rejects(
    admin.query('SELECT public.admin_regrant_exam_access($1)', [session.id]),
    /Exam deadline has expired; access cannot be re-granted/
  );
});

test('get_admin_terminated_students_page lists terminated sessions with eligibility', async () => {
  const su = await h.asSuperuser();
  const admin = await h.asAdmin();
  const examId = await h.createExam({ status: 'ACTIVE', title: 'Terminated Page Exam' });

  // Student 6: Terminated, active deadline
  const student6 = await h.createStudent({ studentId: 'TERM006', name: 'Active Terminated' });
  const s6 = await h.asStudent(student6.id, student6.sessionId);
  await s6.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s6.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'window_blur']);

  // Student 7: Terminated, expired deadline
  const student7 = await h.createStudent({ studentId: 'TERM007', name: 'Expired Terminated' });
  const s7 = await h.asStudent(student7.id, student7.sessionId);
  await s7.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s7.value('SELECT public.terminate_exam($1::uuid, $2, 1)', [examId, 'escape_key']);
  await su.query(
    'UPDATE public.active_sessions SET deadline_at = clock_timestamp() - interval \'10 minutes\' WHERE student_id = $1',
    [student7.studentId]
  );

  const page = await admin.value(
    'SELECT public.get_admin_terminated_students_page($1, $2, $3)',
    [1, 10, null]
  );
  assert.equal(page.total >= 2, true);
  assert.equal(page.rows.length >= 2, true);

  const s6Record = page.rows.find(s => s.student_id === student6.studentId);
  assert.ok(s6Record);
  assert.equal(s6Record.eligible, true);
  assert.equal(s6Record.termination_reason, 'window_blur');

  const s7Record = page.rows.find(s => s.student_id === student7.studentId);
  assert.ok(s7Record);
  assert.equal(s7Record.eligible, false);
  assert.equal(s7Record.termination_reason, 'escape_key');
});


test('all student mutation RPCs require an access generation after re-grant', async () => {
  const examId = await h.createExam();
  const student = await h.createStudent({ studentId: 'GENREQUIRED' });
  const s = await h.asStudent(student.id, student.sessionId);
  const started = await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s.value("SELECT public.terminate_exam($1::uuid, 'escape', 1)", [examId]);
  const admin = await h.asAdmin();
  await admin.value('SELECT public.admin_regrant_exam_access($1)', [student.id + '_' + examId]);
  const progress = buildProgress(started.jumbled_exam_data, { 'phy-1': '1' });
  for (const [sql, params] of [
    ["SELECT public.terminate_exam($1::uuid, 'tab', NULL)", [examId]],
    ['SELECT public.sync_active_session_progress($1::uuid, $2::jsonb, 1, NULL)', [examId, progress]],
    ['SELECT public.sync_exam_subject_time($1::uuid, $2::jsonb, NULL)', [examId, '{}']],
    ['SELECT public.submit_exam($1::uuid, $2::jsonb, NULL, NULL)', [examId, '[]']]
  ]) {
    await assert.rejects(s.query(sql, params), /positive access generation is required/);
  }
  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT status FROM public.active_sessions WHERE id = $1', [student.id + '_' + examId]), 'IN_PROGRESS');
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_results WHERE exam_id = $1', [examId]), 0);
});

test('terminated pagination counts all matching attempts even on empty pages', async () => {
  const examId = await h.createExam({ title: 'Pagination regression' });
  for (let index = 0; index < 12; index += 1) {
    const student = await h.createStudent({ studentId: `PAGE${index}` });
    const s = await h.asStudent(student.id, student.sessionId);
    await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
    await s.value("SELECT public.terminate_exam($1::uuid, 'tab', 1)", [examId]);
  }
  const admin = await h.asAdmin();
  const first = await admin.value("SELECT public.get_admin_terminated_students_page(1, 10, 'Pagination regression')");
  const second = await admin.value("SELECT public.get_admin_terminated_students_page(2, 10, 'Pagination regression')");
  const empty = await admin.value("SELECT public.get_admin_terminated_students_page(3, 10, 'Pagination regression')");
  assert.equal(first.total, 12);
  assert.equal(second.total, 12);
  assert.equal(empty.total, 12);
  assert.equal(first.rows.length, 10);
  assert.equal(second.rows.length, 2);
  assert.deepEqual(empty.rows, []);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.session_id)).size, 12);
});
