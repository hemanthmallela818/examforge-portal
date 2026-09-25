import type { ActionContext } from '../types.ts';

/**
 * Confirms the class exists and lists the section. Returns the error response
 * to send, or null when the assignment is valid.
 */
export async function verifyClassSection(
  { admin, json }: ActionContext,
  className: string,
  section: string,
): Promise<Response | null> {
  const { data: classRow, error: classErr } = await admin
    .from('classes')
    .select('sections')
    .eq('name', className)
    .maybeSingle<{ sections?: unknown }>();

  if (classErr) {
    return json({ error: 'Failed to verify class and section' }, 500);
  }
  if (!classRow || !Array.isArray(classRow.sections) || !classRow.sections.includes(section)) {
    return json({ error: 'The selected class and section do not exist' }, 400);
  }
  return null;
}
