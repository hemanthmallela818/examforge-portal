import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readConnectedStaging } from './connected-staging.mjs';

if (process.env.RESET_CONFIRM_DISPOSABLE !== 'YES_RESET_JEE_STAGING_APPLICATION_DATA') {
  throw new Error('Explicit destructive staging reset confirmation is required.');
}
process.env.REHEARSAL_CONFIRM_DISPOSABLE = 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL';
const staging = readConnectedStaging();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(staging.url, staging.serviceKey, options);
const root = createClient(staging.url, staging.publicKey, options);
const suffix = Date.now();
const className = `Reset Proof ${suffix}`;
const studentId = `RST${String(suffix).slice(-9)}`;
const studentPassword = `S-${randomBytes(24).toString('base64url')}!`;
let studentUserId;

const owner = await service.from('application_owner').select('user_id').single();
if (owner.error || !owner.data?.user_id) throw new Error('Staging root owner is not registered.');
const ownerUser = await service.auth.admin.getUserById(owner.data.user_id);
const ownerEmail = ownerUser.data?.user?.email;
if (ownerUser.error || !ownerEmail) throw new Error('Staging root Auth account is unavailable.');
const ownerLink = await service.auth.admin.generateLink({ type: 'magiclink', email: ownerEmail });
const tokenHash = ownerLink.data?.properties?.hashed_token;
if (ownerLink.error || !tokenHash) throw new Error('Could not create the staging root verification session.');
const rootLogin = await root.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
if (rootLogin.error) throw new Error(`Root session verification failed: ${rootLogin.error.message}`);

const preservedBefore = await Promise.all([
  service.from('application_owner').select('*', { count: 'exact', head: true }),
  service.from('managed_administrators').select('*', { count: 'exact', head: true }),
]);
if (preservedBefore.some(result => result.error)) throw new Error('Could not read preserved account counts.');

const classInsert = await service.from('classes').insert({ name: className, sections: ['A'] });
if (classInsert.error) throw new Error(`Reset-proof class setup failed: ${classInsert.error.message}`);
const studentCreation = await root.functions.invoke('manage-student', {
  body: {
    action: 'create', studentId, name: 'Reset Proof Student', password: studentPassword,
    className, section: 'A',
  },
});
if (studentCreation.error || !studentCreation.data?.id) {
  throw new Error(`Reset-proof student setup failed: ${studentCreation.data?.error || studentCreation.error?.message || 'unknown error'}`);
}
studentUserId = studentCreation.data.id;

const questionInsert = await service.from('question_bank').insert({
  subject: 'Physics', type: 'MCQ', question_text: `Reset proof ${suffix}`,
  options: ['A', 'B', 'C', 'D'], correct_answer: '0', has_image_or_diagram: false,
});
if (questionInsert.error) throw new Error(`Reset-proof question setup failed: ${questionInsert.error.message}`);
const historyInsert = await service.from('import_history').insert({
  file_name: `reset-proof-${suffix}.json`, total_questions: 1, successful_imports: 1,
  rejected_questions: 0, status: 'Success',
});
if (historyInsert.error) throw new Error(`Reset-proof history setup failed: ${historyInsert.error.message}`);

const preview = await root.functions.invoke('manage-student', { body: { action: 'preview-reset' } });
if (preview.error || !preview.data?.preview) throw new Error('Root reset preview failed.');
if (preview.data.preview.student_accounts < 1 || preview.data.preview.classes < 1
  || preview.data.preview.questions < 1 || preview.data.preview.import_history < 1) {
  throw new Error('Root reset preview omitted disposable staging data.');
}

const reset = await root.functions.invoke('manage-student', {
  body: { action: 'reset-application', confirmation: 'RESET APPLICATION DATA' },
});
if (reset.error || reset.data?.reset !== true) {
  throw new Error(`Root reset failed: ${reset.data?.error || reset.error?.message || 'unknown error'}`);
}

const clearedTables = [
  'active_sessions', 'student_results', 'cbt_exams_raw', 'exam_status_events',
  'question_import_batches', 'import_history', 'question_bank', 'students', 'classes',
];
for (const table of clearedTables) {
  const check = await service.from(table).select('*', { count: 'exact', head: true });
  if (check.error || check.count !== 0) throw new Error(`${table} was not empty after reset.`);
}

const [ownerAfter, managedAfter, resetAudit, deletedStudent] = await Promise.all([
  service.from('application_owner').select('*', { count: 'exact', head: true }),
  service.from('managed_administrators').select('*', { count: 'exact', head: true }),
  service.from('admin_audit_events').select('action').eq('action', 'RESET_APPLICATION_DATA'),
  service.auth.admin.getUserById(studentUserId),
]);
if (ownerAfter.error || ownerAfter.count !== preservedBefore[0].count) throw new Error('Root ownership was not preserved.');
if (managedAfter.error || managedAfter.count !== preservedBefore[1].count) throw new Error('Managed administrators were not preserved.');
if (resetAudit.error || resetAudit.data?.length !== 1) throw new Error('Reset audit record was not retained.');
if (!deletedStudent.error || deletedStudent.data?.user) throw new Error('Disposable student Auth account was not deleted.');

console.log(JSON.stringify({
  verified: true,
  previewed: true,
  databaseCleared: true,
  studentAuthDeleted: true,
  rootPreserved: true,
  administratorsPreserved: true,
  resetAuditRetained: true,
}));
