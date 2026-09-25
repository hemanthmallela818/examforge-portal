import type { ActionContext } from '../types.ts';
import type { CreateAdminInput } from '../validation.ts';

// Root-only: provision a managed administrator, rolling the Auth account back
// if the application-side registration cannot be completed.
export async function createAdmin(
  { admin, user, json }: ActionContext,
  { email, name, password }: CreateAdminInput,
): Promise<Response> {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name },
    app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
  });
  if (createError || !created?.user) return json({ error: 'Administrator creation failed; check whether the email already exists' }, 400);
  const id = created.user.id;
  const { error: finalizeError } = await admin.rpc('complete_account_provisioning', { account_id_param: id });
  const { error: registerError } = finalizeError ? { error: finalizeError } : await admin.rpc('register_managed_administrator', {
    account_id_param: id, creator_id_param: user.id
  });
  if (registerError) {
    const { error: rollbackError } = await admin.auth.admin.deleteUser(id);
    return json({ error: rollbackError ? 'Account setup failed; incomplete account needs operator cleanup' : 'Account setup failed and was rolled back' }, 500);
  }
  return json({ id, email, name }, 201);
}
