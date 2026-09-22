import { createClient } from '@supabase/supabase-js';
import { readLocalSupabase } from '../e2e/support/local-supabase.mjs';

const local = readLocalSupabase();
const service = createClient(local.url, local.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const email = `hierarchy-probe-${Date.now()}@e2e.local`;
const { data: created, error: createError } = await service.auth.admin.createUser({
  email,
  password: 'Hierarchy-Probe!2026',
  email_confirm: true,
  user_metadata: { name: 'Hierarchy Probe' },
  app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
});
if (createError || !created?.user) throw createError || new Error('Probe account was not created.');
const id = created.user.id;
try {
  const finalized = await service.rpc('complete_account_provisioning', { account_id_param: id });
  if (finalized.error) throw new Error(`finalize: ${finalized.error.message}`);
  const { data: owners, error: ownerError } = await service.from('application_owner').select('user_id').limit(1);
  if (ownerError || !owners?.[0]) throw ownerError || new Error('No root owner is registered.');
  const registered = await service.rpc('register_managed_administrator', {
    account_id_param: id,
    creator_id_param: owners[0].user_id
  });
  if (registered.error) throw new Error(`register: ${registered.error.message}`);
  console.log(JSON.stringify({ verified: true, rootOwnerPresent: true }));
} finally {
  await service.auth.admin.deleteUser(id);
}
