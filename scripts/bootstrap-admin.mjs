import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.BOOTSTRAP_ROOT_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ROOT_PASSWORD;
const name = process.env.BOOTSTRAP_ROOT_NAME?.trim() || 'Root Developer';
const explicitUserId = process.env.BOOTSTRAP_ROOT_USER_ID?.trim();

if (!url || !serviceRoleKey || !email || !password) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BOOTSTRAP_ROOT_EMAIL, and BOOTSTRAP_ROOT_PASSWORD are required.');
}
if (password.length < 12) {
  throw new Error('The root developer password must contain at least 12 characters.');
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const { data: existingOwner, error: ownerReadError } = await admin
  .from('application_owner').select('user_id').maybeSingle();
if (ownerReadError) throw new Error(`Could not inspect root ownership: ${ownerReadError.message}`);

if (explicitUserId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(explicitUserId)) {
  throw new Error('BOOTSTRAP_ROOT_USER_ID must be a valid UUID when provided.');
}
let existingUser;
if (explicitUserId) {
  existingUser = { id: explicitUserId, email, user_metadata: {}, app_metadata: {} };
} else {
  const { data: users, error: usersError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (usersError) throw new Error(`Could not inspect Auth users: ${usersError.message}`);
  existingUser = users.users.find(user => user.email?.toLowerCase() === email);
}
if (existingOwner && existingUser?.id !== existingOwner.user_id) {
  throw new Error('A different root developer is already registered. Ownership was not changed.');
}

let created = false;
let user;
if (existingUser) {
  const { data, error } = await admin.auth.admin.updateUserById(existingUser.id, {
    password,
    email_confirm: true,
    user_metadata: { ...existingUser.user_metadata, name },
    app_metadata: { ...existingUser.app_metadata, provisioned_by: 'admin', account_type: 'admin' }
  });
  if (error || !data.user) throw error || new Error('Auth did not return the updated root developer.');
  user = data.user;
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
    app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
  });
  if (error || !data.user) throw error || new Error('Auth did not return the created root developer.');
  user = data.user;
  created = true;
}

const { error: finalizeError } = await admin.rpc('complete_account_provisioning', {
  account_id_param: user.id
});
if (finalizeError) {
  if (created) {
    const { error: rollbackError } = await admin.auth.admin.deleteUser(user.id);
    if (rollbackError) throw new Error(`Root profile setup failed and Auth rollback was incomplete: ${finalizeError.message}`);
  }
  throw new Error(`Root profile setup failed${created ? ' and the Auth account was rolled back' : ''}: ${finalizeError.message}`);
}

const { error: registerError } = await admin.from('application_owner').upsert({
  singleton: true,
  user_id: user.id
}, { onConflict: 'singleton' });
if (registerError) {
  if (created) await admin.auth.admin.deleteUser(user.id);
  throw new Error(`Root ownership registration failed: ${registerError.message}`);
}

console.log(JSON.stringify({ created, rootRegistered: true, id: user.id, email: user.email }));
