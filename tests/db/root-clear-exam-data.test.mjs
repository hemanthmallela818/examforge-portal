import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ID, ROOT_ID, createTestDb } from './harness.mjs';

let h;
let student;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
  student = await h.createStudent({ studentId: 'ROOT-CLEAR-S1', name: 'Preserved Student' });

  // Add question bank items
  const admin = await h.asAdmin();
  await admin.query(
    `INSERT INTO public.question_bank (subject, type, question_text, options, correct_answer)
     VALUES ('Physics', 'MCQ', 'Preserved Question', '["1","2","3","4"]', '0')`
  );
});

after(async () => {
  await h?.close();
});

test('root clear exam data guards deny direct client calls and non-root actors', async () => {
  // Direct client calls from authenticated users fail (service_role only)
  for (const handle of [await h.asRoot(), await h.asAdmin(), await h.asStudent(student.id, student.sessionId)]) {
    await assert.rejects(
      handle.query('SELECT public.root_clear_exam_data_preview()'),
      /permission denied/
    );
    await assert.rejects(
      handle.query(`SELECT public.root_clear_exam_data('CLEAR EXAM DATA')`),
      /permission denied/
    );
    await assert.rejects(
      handle.query('SELECT public.root_clear_exam_data_preview_for_actor($1::uuid)', [ROOT_ID]),
      /permission denied/
    );
    await assert.rejects(
      handle.query(`SELECT public.root_clear_exam_data_for_actor($1::uuid, 'CLEAR EXAM DATA')`, [ROOT_ID]),
      /permission denied/
    );
  }

  // Service role path enforces root developer identity
  const svc = await h.asService();
  for (const actor of [ADMIN_ID, student.id, null]) {
    await assert.rejects(
      svc.query('SELECT public.root_clear_exam_data_preview_for_actor($1::uuid)', [actor]),
      /Root developer access is required/
    );
    await assert.rejects(
      svc.query(`SELECT public.root_clear_exam_data_for_actor($1::uuid, 'CLEAR EXAM DATA')`, [actor]),
      /Root developer access is required/
    );
  }

  // Exact confirmation required
  await assert.rejects(
    svc.query(`SELECT public.root_clear_exam_data_for_actor($1::uuid, 'clear exam data')`, [ROOT_ID]),
    /Exact clear confirmation is required/
  );
});

test('root clear exam data removes only exam items and preserves students, classes, and question bank', async () => {
  const su = await h.asSuperuser();
  const svc = await h.asService();

  // Create an active exam and student attempt
  const examId = await h.createExam({ title: 'Exam to be cleared', status: 'ACTIVE' });
  const s = await h.asStudent(student.id, student.sessionId);
  await s.value('SELECT public.start_exam_session($1::uuid, NULL, NULL)', [examId]);
  await s.value('SELECT public.submit_exam($1::uuid, $2::jsonb, 1, 1)', [examId, '[]']);

  // Verify exam records exist
  assert.equal(await su.value('SELECT count(*)::int FROM public.cbt_exams_raw WHERE id = $1', [examId]), 1);
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_results WHERE exam_id = $1', [examId]), 1);

  // Preview shows counts
  const preview = await svc.value('SELECT public.root_clear_exam_data_preview_for_actor($1::uuid)', [ROOT_ID]);
  assert.ok(preview.exams >= 1);
  assert.ok(preview.results >= 1);

  // Execute root clear
  const result = await svc.value(`SELECT public.root_clear_exam_data_for_actor($1::uuid, 'CLEAR EXAM DATA')`, [ROOT_ID]);
  assert.equal(result.cleared, true);
  assert.ok(result.deleted.exams >= 1);
  assert.ok(result.deleted.results >= 1);

  // Exam tables are completely cleared
  assert.equal(await su.value('SELECT count(*)::int FROM public.cbt_exams_raw'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.cbt_exam_answers'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.active_sessions'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_results'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.student_result_reviews'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.exam_status_events'), 0);

  // Academic roster and question bank are completely preserved!
  assert.equal(await su.value('SELECT count(*)::int FROM public.students WHERE id = $1', [student.id]), 1);
  assert.equal(await su.value('SELECT count(*)::int FROM public.classes WHERE name = \'12\''), 1);
  assert.equal(await su.value('SELECT count(*)::int FROM public.question_bank'), 1);

  // Audit event was recorded
  const audit = (await su.rows(
    `SELECT action, actor_user_id, target_type, metadata FROM public.admin_audit_events WHERE action = 'CLEAR_EXAM_DATA'`
  ))[0];
  assert.ok(audit);
  assert.equal(audit.actor_user_id, ROOT_ID);
  assert.equal(audit.target_type, 'exams');
  assert.equal(audit.metadata.preserved, 'students_classes_subjects_patterns_question_bank_imports_settings_audit_storage');
});
