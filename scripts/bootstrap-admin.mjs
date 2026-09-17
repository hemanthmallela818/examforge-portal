import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Administrator';

if (!url || !serviceRoleKey || !email || !password) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BOOTSTRAP_ADMIN_EMAIL, and BOOTSTRAP_ADMIN_PASSWORD are required.');
}
if (password.length < 12) {
  throw new Error('The bootstrap administrator password must contain at least 12 characters.');
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const { data, error } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { name },
  app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
});

if (error || !data?.user) throw error || new Error('Auth did not return the created administrator.');

const { error: finalizeError } = await admin.rpc('complete_account_provisioning', {
  account_id_param: data.user.id
});
if (finalizeError) {
  const { error: rollbackError } = await admin.auth.admin.deleteUser(data.user.id);
  if (rollbackError) {
    throw new Error(`Administrator profile setup failed and Auth rollback was incomplete: ${finalizeError.message}`);
  }
  throw new Error(`Administrator profile setup failed and the Auth account was rolled back: ${finalizeError.message}`);
}

console.log(JSON.stringify({ created: true, id: data.user.id, email: data.user.email }));
