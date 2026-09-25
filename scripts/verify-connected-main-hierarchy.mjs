import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { readConnectedMain } from './connected-main.mjs';

const main = readConnectedMain();
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(main.url, main.serviceKey, clientOptions);
const root = createClient(main.url, main.publicKey, clientOptions);
const suffix = Date.now();
const adminEmail = `main-root-check-${suffix}@e2e.local`;
const adminPassword = `A-${randomBytes(24).toString('base64url')}!`;
const className = `Main Root Check ${suffix}`;
const studentId = `MAINCHK${String(suffix).slice(-8)}`;
const studentPassword = `S-${randomBytes(24).toString('base64url')}!`;
let adminId;
let studentUserId;

try {
  const owner = await service.from('application_owner').select('user_id').eq('singleton', true).single();
  if (owner.error || !owner.data?.user_id) throw new Error('Main-project root owner is not registered.');

  const ownerUser = await service.auth.admin.getUserById(owner.data.user_id);
  const ownerEmail = ownerUser.data?.user?.email;
  if (ownerUser.error || !ownerEmail) throw new Error('Main-project root Auth account is unavailable.');

  const link = await service.auth.admin.generateLink({ type: 'magiclink', email: ownerEmail });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) throw new Error('Could not create a one-time root verification session.');

  const rootLogin = await root.auth.verifyOtp({ type: 'magiclink', token_hash: tokenHash });
  if (rootLogin.error) throw new Error(`Root session verification failed: ${rootLogin.error.message}`);

  const [rootAuthority, adminAuthority] = await Promise.all([
    root.rpc('is_root_developer'),
    root.rpc('is_admin_aal2'),
  ]);
  if (rootAuthority.error || rootAuthority.data !== true || adminAuthority.error || adminAuthority.data !== true) {
    throw new Error('Root authority was not recognized by the main database.');
  }

  const adminCreation = await root.functions.invoke('manage-student', {
    body: { action: 'create-admin', email: adminEmail, name: 'Main Root Check Administrator', password: adminPassword },
  });
  if (adminCreation.error || !adminCreation.data?.id) {
    throw new Error(`Administrator creation check failed: ${adminCreation.data?.error || adminCreation.error?.message || 'unknown error'}`);
  }
  adminId = adminCreation.data.id;

  const admin = createClient(main.url, main.publicKey, clientOptions);
  const adminLogin = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (adminLogin.error) throw new Error(`Managed administrator sign-in failed: ${adminLogin.error.message}`);
  const [adminAllowed, adminIsRoot] = await Promise.all([
    admin.rpc('is_admin_aal2'),
    admin.rpc('is_root_developer'),
  ]);
  if (adminAllowed.error || adminAllowed.data !== true || adminIsRoot.error || adminIsRoot.data !== false) {
    throw new Error('Managed administrator authority boundaries are incorrect.');
  }

  const classInsert = await service.from('classes').insert({ name: className, sections: ['A'] });
  if (classInsert.error) throw new Error(`Temporary class setup failed: ${classInsert.error.message}`);

  const studentCreation = await admin.functions.invoke('manage-student', {
    body: {
      action: 'create', studentId, name: 'Main Root Check Student', password: studentPassword,
      className, section: 'A',
    },
  });
  if (studentCreation.error || !studentCreation.data?.id) {
    throw new Error(`Student creation check failed: ${studentCreation.data?.error || studentCreation.error?.message || 'unknown error'}`);
  }
  studentUserId = studentCreation.data.id;

  const disable = await root.rpc('set_managed_administrator_enabled', {
    account_id_param: adminId,
    enabled_param: false,
  });
  if (disable.error) throw new Error(`Administrator disable check failed: ${disable.error.message}`);
  const disabledAccess = await admin.rpc('is_admin_aal2');
  if (disabledAccess.error || disabledAccess.data !== false) throw new Error('Disabled administrator retained access.');

  const student = createClient(main.url, main.publicKey, clientOptions);
  const studentLogin = await student.auth.signInWithPassword({
    email: `${studentId.toLowerCase()}@students.examforge.invalid`, password: studentPassword,
  });
  if (studentLogin.error) throw new Error(`Student sign-in failed: ${studentLogin.error.message}`);
  const studentRole = await student.rpc('get_my_role');
  if (studentRole.error || studentRole.data !== 'student') throw new Error('Student role verification failed.');

  console.log(JSON.stringify({
    verified: true,
    rootOneTimeSession: true,
    rootCreatesAdministrator: true,
    administratorCreatesStudent: true,
    disableRevokesAccess: true,
  }));
} finally {
  if (studentUserId) await service.auth.admin.deleteUser(studentUserId);
  if (adminId) await service.auth.admin.deleteUser(adminId);
  await service.from('classes').delete().eq('name', className);
}
