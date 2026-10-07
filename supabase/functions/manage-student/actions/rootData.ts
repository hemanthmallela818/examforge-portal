// Root-only destructive data actions: scoped cleanup, and clearing exam data.
// Replaces full application reset so students and login credentials are preserved.

import type { ActionContext, QueryResult } from '../types.ts';
import type { ScopedCleanupInput } from '../validation.ts';

export async function clearScopedData(
  { admin, user, json, safeDbMessage }: ActionContext,
  { target, confirmation }: ScopedCleanupInput,
): Promise<Response> {
  const { data: cleared, error: clearError }: QueryResult<{ deleted?: unknown }> = await admin.rpc('root_clear_scoped_data_for_actor', {
    actor_id_param: user.id,
    target_param: target,
    confirmation_param: confirmation,
  });
  if (clearError || !cleared) return json({ error: safeDbMessage(clearError, 'Scoped cleanup failed') }, 500);
  return json({ cleared: true, target, deleted: cleared.deleted }, 200);
}

export async function previewReset({ admin, user, json, safeDbMessage }: ActionContext): Promise<Response> {
  const { data: preview, error: previewError } = await admin.rpc('root_clear_exam_data_preview_for_actor', {
    actor_id_param: user.id,
  });
  if (previewError) {
    return json({ error: safeDbMessage(previewError, 'Unable to preview clearing exam data') }, 500);
  }
  return json({ preview }, 200);
}

interface ClearExamDataResult {
  cleared?: boolean;
  deleted?: unknown;
  preserved?: string;
}

export async function resetApplication(
  { admin, user, json, safeDbMessage }: ActionContext,
  { confirmation }: { confirmation: string },
): Promise<Response> {
  const { data: clearResult, error: clearError }: QueryResult<ClearExamDataResult> = await admin.rpc('root_clear_exam_data_for_actor', {
    actor_id_param: user.id,
    confirmation_param: confirmation,
  });
  if (clearError || !clearResult) {
    return json({ error: safeDbMessage(clearError, 'Clearing exam data failed') }, 500);
  }

  return json({
    reset: true,
    cleared: true,
    deleted: clearResult.deleted,
    preserved: clearResult.preserved,
  }, 200);
}

export const previewClearExamData = previewReset;
export const clearExamData = resetApplication;
