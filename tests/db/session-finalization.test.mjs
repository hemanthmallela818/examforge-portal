import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ADMIN_ID,
  DEFAULT_CORRECT,
  MIGRATIONS_DIR,
  SCHEDULER_ACTOR_ID,
  buildProgress,
  createTestDb,
  listMigrations
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

/** Returns the SQL command the latest migration schedules with pg_cron. */
// The latest scheduling of a named pg_cron job (other jobs, e.g. client-error
// retention, are scheduled by later migrations).
function scheduledCronCommand(jobName = 'examforge-finalize-expired-sessions') {
  let command;
  for (const file of listMigrations()) {
    const sql = readFileSync(new URL(file, MIGRATIONS_DIR), 'utf8');
    for (const match of sql.matchAll(/cron\.schedule\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\s*\)/g)) {
      if (match[1] === jobName) command = { file, name: match[1], schedule: match[2], sql: match[3] };
    }
  }
  return command;
}

async function startWithProgress(studentId, examId, answers) {
  const student = await h.createStudent({ studentId });
  const s = await h.asStudent(student.id, student.sessionId);
  const started = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
  const saved = await s.value(
    'SELECT public.sync_active_session_progress($1, $2, 1)',
    [examId, buildProgress(started.jumbled_exam_data, answers)]
  );
  assert.equal(saved.success, true);
  return student;
}

async function setDeadline(studentId, examId, offsetSql) {
  const su = await h.asSuperuser();
  await su.query(
    `UPDATE public.active_sessions
     SET deadline_at = clock_timestamp() + $3::interval,
         started_at = clock_timestamp() + $3::interval - interval '60 minutes'
     WHERE student_id = $1 AND exam_id = $2`,
    [studentId, examId, offsetSql]
  );
}

async function sessionExists(studentId, examId) {
  const su = await h.asSuperuser();
  return (await su.value(
    'SELECT count(*)::int FROM public.active_sessions WHERE student_id = $1 AND exam_id = $2',
    [studentId, examId]
  )) === 1;
}

async function resultFor(studentId, examId) {
  const su = await h.asSuperuser();
  return (await su.rows(
    'SELECT total_score::float AS total, correct, incorrect, unattempted FROM public.student_results WHERE student_id = $1 AND exam_id = $2',
    [studentId, examId]
  ))[0];
}

test('pg_cron job (when available) runs run_scheduled_session_finalization every minute', () => {
  const command = scheduledCronCommand();
  assert.ok(command, 'a migration schedules the finalizer with pg_cron');
  assert.equal(command.schedule, '* * * * *');
  assert.equal(command.sql, 'SELECT public.run_scheduled_session_finalization()');
});

test('scheduler finalizes only sessions past deadline + grace, grading the server snapshot', async () => {
  const examId = await h.createExam();
  const expired = await startWithProgress('FIN-EXPIRED', examId, { 'phy-1': '1', 'math-1': '2.5' });
  const inGrace = await startWithProgress('FIN-GRACE', examId, DEFAULT_CORRECT);
  const running = await startWithProgress('FIN-RUNNING', examId, DEFAULT_CORRECT);

  await setDeadline(expired.studentId, examId, '-10 minutes');
  await setDeadline(inGrace.studentId, examId, '-30 seconds'); // inside 120s grace
  await setDeadline(running.studentId, examId, '+20 minutes');

  // Run exactly what pg_cron would run, as the cron owner (no JWT).
  const su = await h.asSuperuser();
  const outcome = await su.value(scheduledCronCommand().sql);
  assert.deepEqual(outcome, { finalized: 1, skipped: 0, failed: 0 });

  assert.equal(await sessionExists(expired.studentId, examId), false);
  assert.deepEqual(await resultFor(expired.studentId, examId), {
    total: 8, correct: 2, incorrect: 0, unattempted: 1
  });
  assert.equal(await sessionExists(inGrace.studentId, examId), true);
  assert.equal(await sessionExists(running.studentId, examId), true);
  assert.equal(await resultFor(inGrace.studentId, examId), undefined);
  assert.equal(await resultFor(running.studentId, examId), undefined);

  const audits = await su.rows(
    `SELECT actor_user_id, target_type, metadata FROM public.admin_audit_events
     WHERE action = 'FINALIZE_EXPIRED_SESSION' AND metadata->>'exam_id' = $1`,
    [examId]
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_user_id, SCHEDULER_ACTOR_ID);
  assert.equal(audits[0].target_type, 'active_session');
  assert.equal(audits[0].metadata.source, 'scheduler');
  assert.equal(audits[0].metadata.student_id, expired.studentId);

  // The finalizer restores the caller's claims after impersonating the student.
  assert.equal(await su.value(`SELECT current_setting('request.jwt.claim.sub', true)`), '');

  // Running again is a no-op for the already-finalized and still-running sessions.
  assert.deepEqual(await su.value('SELECT public.run_scheduled_session_finalization()'), {
    finalized: 0, skipped: 0, failed: 0
  });

  // The expired student's stale device receives the committed result.
  const stale = await h.asStudent(expired.id, expired.sessionId);
  const recovered = await stale.value('SELECT public.submit_exam($1, NULL, 2)', [examId]);
  assert.equal(recovered.totalScore, 8);

  // Clean up remaining sessions for the next test.
  await setDeadline(inGrace.studentId, examId, '-10 minutes');
  await setDeadline(running.studentId, examId, '-10 minutes');
  assert.equal((await su.value('SELECT public.run_scheduled_session_finalization()')).finalized, 2);
});

test('scheduler entry points are not callable by API roles', async () => {
  const student = await h.createStudent({ studentId: 'FIN-PRIV' });
  const handles = [
    await h.asStudent(student.id, student.sessionId),
    await h.asAdmin(),
    await h.asAnon()
  ];
  for (const handle of handles) {
    await assert.rejects(
      handle.query('SELECT public.run_scheduled_session_finalization()'),
      /permission denied for function run_scheduled_session_finalization/
    );
    await assert.rejects(
      handle.query(`SELECT public.finalize_expired_sessions_internal(10, 0, $1, 'scheduler')`, [ADMIN_ID]),
      /permission denied for function finalize_expired_sessions_internal/
    );
  }
});

test('admin_finalize_expired_sessions requires an administrator and uses no grace period', async () => {
  const examId = await h.createExam();
  const pending = await startWithProgress('FIN-ADMIN', examId, { 'phy-2': '2' });
  await setDeadline(pending.studentId, examId, '-5 seconds');

  const student = await h.asStudent(pending.id, pending.sessionId);
  await assert.rejects(
    student.query('SELECT public.admin_finalize_expired_sessions(100)'),
    /Administrator access is required/
  );

  const su = await h.asSuperuser();
  // The scheduler's 120s grace still protects this attempt ...
  assert.equal((await su.value('SELECT public.run_scheduled_session_finalization()')).finalized, 0);

  // ... but an administrator finalizes immediately after the deadline.
  const admin = await h.asAdmin();
  assert.deepEqual(await admin.value('SELECT public.admin_finalize_expired_sessions(100)'), {
    finalized: 1, skipped: 0, failed: 0
  });
  await assert.rejects(
    admin.query('SELECT public.admin_finalize_expired_sessions(0)'),
    /Batch limit must be between 1 and 500/
  );
  assert.deepEqual(await resultFor(pending.studentId, examId), {
    total: 4, correct: 1, incorrect: 0, unattempted: 2
  });
  const audit = (await su.rows(
    `SELECT actor_user_id, metadata FROM public.admin_audit_events
     WHERE action = 'FINALIZE_EXPIRED_SESSION' AND metadata->>'exam_id' = $1`,
    [examId]
  ))[0];
  assert.equal(audit.actor_user_id, ADMIN_ID);
  assert.equal(audit.metadata.source, 'administrator');
});

test('resuming an attempt after its deadline auto-submits the server snapshot', async () => {
  const examId = await h.createExam();
  const student = await startWithProgress('FIN-RESUME', examId, { 'phy-1': '0' });
  await setDeadline(student.studentId, examId, '-1 second');
  const s = await h.asStudent(student.id, student.sessionId);
  const resumed = await s.value('SELECT public.start_exam_session($1, NULL, NULL)', [examId]);
  assert.equal(resumed.expired, true);
  assert.equal(resumed.time_left, 0);
  assert.deepEqual(
    { correct: resumed.result.correct, incorrect: resumed.result.incorrect, totalScore: resumed.result.totalScore },
    { correct: 0, incorrect: 1, totalScore: -1 }
  );
});

test('operational health reports the scheduler and redundant indexes are gone', async () => {
  const admin = await h.asAdmin();
  const health = await admin.value('SELECT public.admin_operational_health()');
  assert.ok(health.scheduler, 'health includes a scheduler section');
  // PGlite has no pg_cron, so the finalizer is reported as unavailable (and not unhealthy).
  assert.equal(health.scheduler.available, false);
  assert.equal(health.scheduler.healthy, true);
  assert.ok(['HEALTHY', 'ATTENTION'].includes(health.status));

  const student = await h.asUser('00000000-0000-4000-8000-00000000abcd');
  await assert.rejects(student.query('SELECT public.admin_operational_health()'), /Administrator access is required|permission denied/);

  const su = await h.asSuperuser();
  const indexes = await su.rows("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'student_results'");
  const names = indexes.map(row => row.indexname);
  assert.ok(!names.includes('student_results_exam_id_idx'));
  assert.ok(!names.includes('student_results_student_id_idx'));
  assert.ok(names.includes('student_results_exam_student_idx'));
  assert.ok(names.includes('student_results_student_exam_key'));
});
