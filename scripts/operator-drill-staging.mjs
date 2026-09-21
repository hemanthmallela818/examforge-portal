import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { generateTotp } from '../e2e/support/fixtures.mjs';
import { readConnectedStaging } from './connected-staging.mjs';

const { projectRef, serviceKey, publicKey, url } = readConnectedStaging();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(url, serviceKey, options);
let browser = createClient(url, publicKey, options);
const prefix = `OPERATOR-DRILL-${Date.now()}`;
const email = `${prefix.toLowerCase()}@rehearsal.local`;
const password = `${randomBytes(32).toString('base64url')}!aA1`;
const className = `${prefix}-CLASS`;
let userId;
let classId;
let examId;
let phase = 'temporary operator setup';
let failed = false;
const requireData = (result, description) => {
  if (result.error) throw new Error(`${description} failed.`);
  return result.data;
};
const reachAal2 = async client => {
  const enrollment = requireData(await client.auth.mfa.enroll({ factorType: 'totp' }), 'MFA enrollment');
  requireData(await client.auth.mfa.challengeAndVerify({
    factorId: enrollment.id, code: generateTotp(enrollment.totp.secret)
  }), 'MFA verification');
  requireData(await client.auth.refreshSession(), 'AAL2 session refresh');
  const assurance = requireData(await client.auth.mfa.getAuthenticatorAssuranceLevel(), 'AAL inspection');
  if (assurance.currentLevel !== 'aal2') throw new Error('Operator session did not reach AAL2.');
  return enrollment.id;
};
try {
  const created = requireData(await service.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name: 'Disposable Operator Drill Administrator' },
    app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
  }), 'Operator creation');
  userId = created.user.id;
  requireData(await service.rpc('complete_account_provisioning', { account_id_param: userId }), 'Operator provisioning');
  requireData(await browser.auth.signInWithPassword({ email, password }), 'Operator sign-in');

  phase = 'AAL1 rejection';
  const aal1Health = await browser.rpc('admin_operational_health');
  if (!aal1Health.error || !/AAL2|MFA/i.test(aal1Health.error.message)) {
    throw new Error('AAL1 operator unexpectedly reached privileged health data.');
  }

  phase = 'AAL2 authorization';
  const firstFactorId = await reachAal2(browser);
  const classRow = requireData(await service.from('classes').insert({ name: className, sections: ['A'] }).select('id').single(), 'Class setup');
  classId = classRow.id;
  const questionsData = {
    subjects: ['Physics'], duration: 5, marksCorrect: 4, marksIncorrect: -1,
    questions: { Physics: [{ id: `${prefix}-Q1`, subject: 'Physics', type: 'NUMERICAL',
      text: 'Operator drill question', options: [], correctAnswer: '1', hasImageOrDiagram: false }] }
  };
  const exam = requireData(await browser.from('cbt_exams').insert({
    title: `${prefix} Exam`, status: 'PENDING', class: className, section: 'A', questions_data: questionsData
  }).select('id').single(), 'AAL2 exam creation');
  examId = exam.id;
  const preflight = requireData(await browser.rpc('preflight_validate_exam', { exam_id_param: examId }), 'Exam preflight');
  if (!preflight.valid) throw new Error('Operator drill exam did not pass preflight.');
  requireData(await browser.from('cbt_exams').update({ status: 'ACTIVE' }).eq('id', examId), 'Emergency activation');
  requireData(await browser.from('cbt_exams').update({ status: 'ENDED' }).eq('id', examId), 'Emergency ending');
  const initialHealth = requireData(await browser.rpc('admin_operational_health'), 'Operational health');

  phase = 'lost-factor recovery';
  requireData(await browser.auth.signOut({ scope: 'global' }), 'Global operator sign-out');
  const listed = requireData(await service.auth.admin.mfa.listFactors({ userId }), 'Factor inventory');
  if (!listed.factors.some(factor => factor.id === firstFactorId && factor.status === 'verified')) {
    throw new Error('Verified factor was not present in the recovery inventory.');
  }
  requireData(await service.auth.admin.mfa.deleteFactor({ userId, id: firstFactorId }), 'Lost-factor removal');
  browser = createClient(url, publicKey, options);
  requireData(await browser.auth.signInWithPassword({ email, password }), 'Recovered operator sign-in');
  await reachAal2(browser);
  const recoveredHealth = requireData(await browser.rpc('admin_operational_health'), 'Recovered operational health');

  phase = 'audited operator cleanup';
  requireData(await browser.rpc('admin_delete_unused_exam', {
    exam_id_param: examId, expected_title_param: `${prefix} Exam`
  }), 'Unused drill exam deletion');
  examId = undefined;
  requireData(await browser.rpc('admin_delete_empty_class', {
    class_id_param: classId, expected_name_param: className
  }), 'Empty drill class deletion');
  classId = undefined;
  const { count, error: auditError } = await service.from('admin_audit_events')
    .select('*', { count: 'exact', head: true }).eq('actor_user_id', userId);
  if (auditError || !count || count < 4) throw new Error('Expected operator audit records were not persisted.');
  console.log(JSON.stringify({ status: 'OPERATOR_DRILL_VERIFIED', projectRef,
    aal1PrivilegedAccessBlocked: true, aal2ExamLifecycleVerified: true,
    emergencyExamEndVerified: true, lostMfaFactorRecoveryVerified: true,
    recoveredHealthStatus: recoveredHealth.status, initialHealthStatus: initialHealth.status,
    auditEvents: count, cleanupCompleted: true }));
} catch {
  console.error(`Operator drill failed during ${phase}; credentials and service errors were suppressed.`);
  failed = true;
} finally {
  await browser.auth.signOut({ scope: 'global' }).catch(() => undefined);
  if (userId) {
    const removed = await service.auth.admin.deleteUser(userId);
    if (removed.error) { console.error('Temporary operator cleanup needs investigation.'); failed = true; }
  }
  // Exam/class cleanup normally uses audited AAL2 RPCs above. If those fail, leave
  // their exact prefixed rows for bounded operator cleanup instead of bypassing controls.
  if (examId || classId) console.error(`Operator drill fixtures with prefix ${prefix} require bounded cleanup.`);
}
process.exitCode = failed ? 1 : 0;
