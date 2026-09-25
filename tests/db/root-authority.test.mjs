import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_ID, ROOT_ID, createTestDb } from './harness.mjs';

let h;
let student;

before(async () => {
  h = await createTestDb();
  await h.seedAdministrators();
  await h.createClass('12', ['A']);
  student = await h.createStudent({ studentId: 'ROOT-S1' });
  const admin = await h.asAdmin();
  await admin.query(
    `INSERT INTO public.question_bank (subject, type, question_text, options, correct_answer)
     VALUES ('Physics', 'MCQ', 'Root test question', '["a","b","c","d"]', '0'),
            ('Mathematics', 'NUMERICAL', 'Root numeric question', '[]', '42')`
  );
});

after(async () => {
  await h?.close();
});

async function questionCount() {
  const su = await h.asSuperuser();
  return su.value('SELECT count(*)::int FROM public.question_bank');
}

test('root and managed administrator identities resolve as expected', async () => {
  const root = await h.asRoot();
  assert.equal(await root.value('SELECT public.is_root_developer()'), true);
  assert.equal(await root.value('SELECT public.is_admin_aal2()'), true);
  const admin = await h.asAdmin();
  assert.equal(await admin.value('SELECT public.is_root_developer()'), false);
  assert.equal(await admin.value('SELECT public.is_admin_aal2()'), true);
  const s = await h.asStudent(student.id, student.sessionId);
  assert.equal(await s.value('SELECT public.is_admin_aal2()'), false);
  assert.equal(await s.value('SELECT public.get_my_role()'), 'student');
});

test('admin_clear_question_bank rejects non-root administrators and students', async () => {
  const admin = await h.asAdmin();
  await assert.rejects(
    admin.query(`SELECT public.admin_clear_question_bank('CLEAR QUESTION BANK')`),
    (error) => error.code === '42501' && /Root developer access is required/.test(error.message)
  );
  const s = await h.asStudent(student.id, student.sessionId);
  await assert.rejects(
    s.query(`SELECT public.admin_clear_question_bank('CLEAR QUESTION BANK')`),
    /Root developer access is required/
  );
  assert.equal(await questionCount(), 2);
});

test('admin_clear_question_bank requires the exact confirmation and works for root', async () => {
  const root = await h.asRoot();
  await assert.rejects(
    root.query(`SELECT public.admin_clear_question_bank('clear question bank')`),
    /Exact question-bank confirmation is required/
  );
  assert.equal(await questionCount(), 2);

  assert.deepEqual(
    await root.value(`SELECT public.admin_clear_question_bank('CLEAR QUESTION BANK')`),
    { deleted: 2 }
  );
  assert.equal(await questionCount(), 0);
  const su = await h.asSuperuser();
  const audit = (await su.rows(
    `SELECT actor_user_id, metadata FROM public.admin_audit_events WHERE action = 'CLEAR_QUESTION_BANK'`
  ))[0];
  assert.equal(audit.actor_user_id, ROOT_ID);
  assert.equal(audit.metadata.deleted_count, 2);
});

test('root reset functions are edge-only and refuse non-root actors', async () => {
  // The direct-JWT variants are not executable through the Data API at all.
  for (const handle of [await h.asRoot(), await h.asAdmin(), await h.asStudent(student.id, student.sessionId)]) {
    await assert.rejects(
      handle.query('SELECT public.root_application_reset_preview()'),
      /permission denied for function root_application_reset_preview/
    );
    await assert.rejects(
      handle.query(`SELECT public.root_reset_application_data('RESET APPLICATION DATA')`),
      /permission denied for function root_reset_application_data/
    );
    await assert.rejects(
      handle.query('SELECT public.root_application_reset_preview_for_actor($1)', [ROOT_ID]),
      /permission denied for function root_application_reset_preview_for_actor/
    );
    await assert.rejects(
      handle.query(`SELECT public.root_reset_application_data_for_actor($1, 'RESET APPLICATION DATA')`, [ROOT_ID]),
      /permission denied for function root_reset_application_data_for_actor/
    );
    await assert.rejects(
      handle.query(`SELECT public.root_clear_scoped_data_for_actor($1, 'question_bank', 'CLEAR QUESTION BANK')`, [ROOT_ID]),
      /permission denied for function root_clear_scoped_data_for_actor/
    );
  }

  // The Edge Function (service_role) path verifies the actor is the owner.
  const svc = await h.asService();
  for (const actor of [ADMIN_ID, student.id, null]) {
    await assert.rejects(
      svc.query('SELECT public.root_application_reset_preview_for_actor($1)', [actor]),
      /Root developer access is required/
    );
    await assert.rejects(
      svc.query(`SELECT public.root_reset_application_data_for_actor($1, 'RESET APPLICATION DATA')`, [actor]),
      /Root developer access is required/
    );
    await assert.rejects(
      svc.query(`SELECT public.root_clear_scoped_data_for_actor($1, 'question_bank', 'CLEAR QUESTION BANK')`, [actor]),
      /Root developer access is required/
    );
  }
  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT count(*)::int FROM public.students'), 1);
});

test('root reset via the service path wipes application data but keeps administrators', async () => {
  const svc = await h.asService();
  const preview = await svc.value('SELECT public.root_application_reset_preview_for_actor($1)', [ROOT_ID]);
  assert.equal(preview.students, 1);
  assert.equal(preview.student_accounts, 1);
  assert.equal(preview.classes, 1);

  await assert.rejects(
    svc.query(`SELECT public.root_reset_application_data_for_actor($1, 'reset')`, [ROOT_ID]),
    /Exact reset confirmation is required/
  );

  const outcome = await svc.value(
    `SELECT public.root_reset_application_data_for_actor($1, 'RESET APPLICATION DATA')`,
    [ROOT_ID]
  );
  assert.deepEqual(outcome.auth_user_ids, [student.id]);
  assert.equal(outcome.deleted.students, 1);

  const su = await h.asSuperuser();
  assert.equal(await su.value('SELECT count(*)::int FROM public.students'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.classes'), 0);
  assert.equal(await su.value('SELECT count(*)::int FROM public.application_owner WHERE user_id = $1', [ROOT_ID]), 1);
  assert.equal(await su.value('SELECT count(*)::int FROM public.managed_administrators WHERE user_id = $1', [ADMIN_ID]), 1);
  const audits = await su.rows('SELECT actor_user_id, action FROM public.admin_audit_events');
  assert.deepEqual(audits, [{ actor_user_id: ROOT_ID, action: 'RESET_APPLICATION_DATA' }]);
});

test('session guards raise stable SQLSTATE codes (EX001/EX003)', async () => {
  const student = await h.createStudent({ studentId: 'ERR-1' });
  // A different session ID than the claimed one = replaced device.
  const stale = await h.asStudent(student.id, '00000000-0000-4000-8000-000000000000');
  // The guard is internal; students reach it through public exam RPCs.
  await assert.rejects(stale.query(
    "SELECT public.sync_exam_subject_time('00000000-0000-4000-8000-000000000001'::uuid, '{}'::jsonb)"
  ), error => {
    assert.equal(error.code, 'EX001');
    assert.match(error.message, /replaced or is no longer active/);
    return true;
  });
});
