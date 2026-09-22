import { createClient } from '@supabase/supabase-js';
import { readConnectedMain } from './connected-main.mjs';

const main = readConnectedMain();
const email = process.env.BOOTSTRAP_ROOT_EMAIL?.trim().toLowerCase();
const password = process.env.BOOTSTRAP_ROOT_PASSWORD;
if (!email || !password) throw new Error('BOOTSTRAP_ROOT_EMAIL and BOOTSTRAP_ROOT_PASSWORD are required.');
const client = createClient(main.url, main.publicKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const login = await client.auth.signInWithPassword({ email, password });
if (login.error) throw new Error(`Root sign-in failed: ${login.error.message}`);
const [root, admin, role] = await Promise.all([
  client.rpc('is_root_developer'),
  client.rpc('is_admin_aal2'),
  client.rpc('get_my_role')
]);
if (root.error || root.data !== true || admin.error || admin.data !== true || role.error || role.data !== 'admin') {
  throw new Error('Main-project root authority verification failed.');
}
console.log(JSON.stringify({ verified: true, passwordLogin: true, rootAuthority: true }));
