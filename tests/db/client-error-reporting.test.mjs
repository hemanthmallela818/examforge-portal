import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './harness.mjs';

let h;
before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
});
after(async () => { await h?.close(); });

test('students can report redacted client errors; fields are capped; reports are rate limited', async () => {
  const student = await h.createStudent({ studentId: 'CE-1' });
  const s = await h.asStudent(student.id, student.sessionId);
  const accepted = await s.value('SELECT public.record_client_error($1)', [{
    context: 'react.render', name: 'TypeError', message: 'x'.repeat(900), code: 'EX001', status: 500, incidentId: 'inc-1', path: '/exam'
  }]);
  assert.equal(accepted, true);

  const su = await h.asSuperuser();
  const [row] = await su.rows('SELECT * FROM public.client_error_events WHERE user_id = $1', [student.id]);
  assert.equal(row.message.length, 500, 'message is capped at 500 characters');
  assert.equal(row.role, 'student');
  assert.equal(row.status, 500);

  for (let i = 0; i < 25; i += 1) {
    await s.value('SELECT public.record_client_error($1)', [{ context: 'loop', name: 'Error', message: `m${i}` }]);
  }
  const count = await su.value('SELECT count(*)::int FROM public.client_error_events WHERE user_id = $1', [student.id]);
  assert.equal(count, 20, 'no more than 20 reports per user per 10 minutes');
});

test('the table is not directly readable and only administrators can list errors', async () => {
  const student = await h.createStudent({ studentId: 'CE-2' });
  const s = await h.asStudent(student.id, student.sessionId);
  await assert.rejects(s.query('SELECT * FROM public.client_error_events'), /permission denied/);
  await assert.rejects(s.query('SELECT public.admin_recent_client_errors(10)'), /Administrator access is required/);

  const anon = await h.asAnon();
  await assert.rejects(anon.query("SELECT public.record_client_error('{}'::jsonb)"), /permission denied/);

  const admin = await h.asAdmin();
  const list = await admin.value('SELECT public.admin_recent_client_errors(5)');
  assert.ok(Array.isArray(list) && list.length > 0 && list.length <= 5);
  const health = await admin.value('SELECT public.admin_operational_health()');
  assert.ok(Number.isInteger(health.client_errors_last_hour) && health.client_errors_last_hour >= 20);
});

test('old reports are purged after 30 days', async () => {
  const su = await h.asSuperuser();
  await su.query("UPDATE public.client_error_events SET occurred_at = now() - interval '31 days' WHERE context = 'loop'");
  const removed = await su.value('SELECT public.purge_old_client_errors()');
  assert.ok(removed > 0);
});
