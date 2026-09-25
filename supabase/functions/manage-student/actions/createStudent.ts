import { STUDENT_EMAIL_DOMAIN } from '../constants.ts';
import type { ActionContext } from '../types.ts';
import type { AssignedInput, NewStudentDetails } from '../validation.ts';
import { verifyClassSection } from './classAssignment.ts';

export async function createStudent(
  ctx: ActionContext,
  { className, section, details }: AssignedInput<NewStudentDetails>,
): Promise<Response> {
  const { admin, user, log, json } = ctx;
  const classFailure = await verifyClassSection(ctx, className, section);
  if (classFailure) return classFailure;
  if (!details.ok) return json({ error: details.error }, 400);
  const { studentId, name, password } = details.value;

  // Check if student ID already exists in roster
  const { data: existingRoster, error: rosterErr } = await admin
    .from('students')
    .select('id')
    .eq('student_id', studentId)
    .maybeSingle();

  if (rosterErr) {
    return json({ error: 'Failed to verify student roster' }, 500);
  }
  if (existingRoster) {
    return json({ error: 'A student with this ID already exists' }, 409);
  }

  // Provision user in Supabase Auth
  const email = `${studentId.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
  const { data, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { student_id: studentId, name, class: className, section },
    app_metadata: { provisioned_by: 'admin', provisioned_by_user: user.id, account_type: 'student' },
  });

  if (createError || !data?.user) {
    if (createError?.message?.toLowerCase().includes('already registered')) {
      return json({ error: 'A student with this ID already exists' }, 409);
    }
    return json({ error: 'Failed to provision student account' }, 400);
  }
  const accountId = data.user.id;

  // Finalize the application profile after GoTrue's Admin API has applied
  // app_metadata. Current GoTrue versions can insert auth.users before custom
  // app_metadata is visible to an AFTER INSERT trigger.
  const { error: finalizeError } = await admin.rpc('complete_account_provisioning', {
    account_id_param: accountId,
  });

  // Verify student profile setup was completed by the atomic finalizer
  const { data: verifiedStudent, error: verifyStudentError } = await admin
    .from('students')
    .select('id')
    .eq('id', accountId)
    .maybeSingle();

  if (finalizeError || verifyStudentError || !verifiedStudent) {
    const correlationId = crypto.randomUUID();
    let rollbackSuccess = false;
    try {
      const { error: deleteErr } = await admin.auth.admin.deleteUser(accountId);
      if (!deleteErr) {
        rollbackSuccess = true;
      } else {
        log.error('student_rollback_failed', { correlationId, userId: accountId });
      }
    } catch {
      log.error('student_rollback_exception', { correlationId, userId: accountId });
    }

    if (!rollbackSuccess) {
      return json({
        error: 'Student provisioning failed and user rollback was incomplete',
        correlationId,
      }, 500);
    }

    return json({ error: 'Student provisioning failed during profile setup' }, 500);
  }

  return json({ id: accountId, studentId }, 201);
}
