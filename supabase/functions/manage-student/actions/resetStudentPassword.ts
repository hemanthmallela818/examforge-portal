import type { ActionContext } from '../types.ts';
import type { ResetStudentPasswordInput } from '../validation.ts';

export async function resetStudentPassword(
  { admin, user, log, json }: ActionContext,
  { studentUserId, password: newPassword }: ResetStudentPasswordInput,
): Promise<Response> {
  const { data: targetProfile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', studentUserId)
    .maybeSingle<{ role?: string }>();
  if (profileErr || targetProfile?.role !== 'student') {
    return json({ error: 'Target user is not a student' }, 400);
  }
  const { data: targetStudent, error: studentErr } = await admin
    .from('students')
    .select('student_id, archived_at')
    .eq('id', studentUserId)
    .maybeSingle<{ student_id?: string; archived_at?: string | null }>();
  if (studentErr || !targetStudent) {
    return json({ error: 'Student record not found' }, 404);
  }
  if (targetStudent.archived_at) {
    return json({ error: 'Reactivate this student before resetting the password' }, 409);
  }
  // Write the audit record first: if it cannot be recorded, the password is not
  // changed, so every reset is guaranteed to be audited (never the password itself).
  const { error: auditError } = await admin.from('admin_audit_events').insert({
    actor_user_id: user.id,
    action: 'RESET_STUDENT_PASSWORD',
    target_type: 'student',
    target_id: studentUserId,
    metadata: { student_id: targetStudent.student_id },
  });
  if (auditError) {
    log.error('password_reset_audit_failed', { studentUserId });
    return json({ error: 'The password reset could not be recorded, so it was not applied' }, 500);
  }
  const { error: updateError } = await admin.auth.admin.updateUserById(studentUserId, {
    password: newPassword,
  });
  if (updateError) {
    await admin.from('admin_audit_events').insert({
      actor_user_id: user.id,
      action: 'RESET_STUDENT_PASSWORD_FAILED',
      target_type: 'student',
      target_id: studentUserId,
      metadata: { student_id: targetStudent.student_id },
    });
    return json({ error: 'Failed to update student password' }, 500);
  }
  return json({ success: true, studentUserId }, 200);
}
