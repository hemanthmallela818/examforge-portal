// Root-only destructive data actions: scoped cleanup, reset preview, and the
// full application reset (database first, then Auth sign-in accounts).

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
  const { data: preview, error: previewError } = await admin.rpc('root_application_reset_preview_for_actor', {
    actor_id_param: user.id,
  });
  if (previewError) {
    return json({ error: safeDbMessage(previewError, 'Unable to preview the application reset') }, 500);
  }
  return json({ preview }, 200);
}

interface ResetResult {
  deleted?: unknown;
  auth_user_ids?: unknown;
}

export async function resetApplication(
  { admin, user, log, json, safeDbMessage }: ActionContext,
  { confirmation }: { confirmation: string },
): Promise<Response> {
  const { data: resetResult, error: resetError }: QueryResult<ResetResult> = await admin.rpc('root_reset_application_data_for_actor', {
    actor_id_param: user.id,
    confirmation_param: confirmation,
  });
  if (resetError || !resetResult) {
    return json({ error: safeDbMessage(resetError, 'Application data reset failed') }, 500);
  }

  // Auth accounts are removed in batches of 10; a failure is retryable because
  // the database reset already committed and returned the remaining IDs.
  const authUserIds: string[] = Array.isArray(resetResult.auth_user_ids) ? resetResult.auth_user_ids : [];
  let deletedAuthUsers = 0;
  const failedAuthUsers: string[] = [];
  for (let offset = 0; offset < authUserIds.length; offset += 10) {
    const batch = authUserIds.slice(offset, offset + 10);
    const outcomes = await Promise.all(batch.map(async (accountId) => {
      const { error } = await admin.auth.admin.deleteUser(accountId);
      return { accountId, error };
    }));
    for (const outcome of outcomes) {
      if (outcome.error) failedAuthUsers.push(outcome.accountId);
      else deletedAuthUsers += 1;
    }
  }

  if (failedAuthUsers.length > 0) {
    const correlationId = crypto.randomUUID();
    log.error('reset_auth_cleanup_incomplete', { correlationId, failedAuthUsers: failedAuthUsers.length });
    return json({
      error: 'Database reset completed, but some student sign-in accounts require a reset retry',
      correlationId,
      deleted: resetResult.deleted,
      deletedAuthUsers,
      failedAuthUsers: failedAuthUsers.length,
    }, 500);
  }

  return json({
    reset: true,
    deleted: resetResult.deleted,
    deletedAuthUsers,
    preserved: 'root_and_administrator_accounts',
  }, 200);
}
