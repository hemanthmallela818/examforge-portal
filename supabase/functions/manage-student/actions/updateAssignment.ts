import type { ActionContext } from '../types.ts';
import type { AssignedInput } from '../validation.ts';
import { verifyClassSection } from './classAssignment.ts';

export async function updateAssignment(
  ctx: ActionContext,
  { className, section, details }: AssignedInput<{ studentUserId: string }>,
): Promise<Response> {
  const { caller, json } = ctx;
  const classFailure = await verifyClassSection(ctx, className, section);
  if (classFailure) return classFailure;
  if (!details.ok) return json({ error: details.error }, 400);
  const { studentUserId } = details.value;

  // Runs as the caller so the database function's own admin check and audit apply.
  const { data: updatedStudent, error: updateError } = await caller.rpc('admin_update_student_assignment', {
    student_user_id_param: studentUserId,
    class_name_param: className,
    section_param: section,
  });

  if (updateError) {
    return json({ error: 'Failed to update student assignment' }, 500);
  }
  return json(updatedStudent || { id: studentUserId }, 200);
}
