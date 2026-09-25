import { createClient } from '@supabase/supabase-js';
import { readConnectedStaging } from './connected-staging.mjs';

process.env.REHEARSAL_CONFIRM_DISPOSABLE = 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL';
const staging = readConnectedStaging();
const rootEmail = process.env.BOOTSTRAP_ROOT_EMAIL?.trim().toLowerCase();
const rootPassword = process.env.BOOTSTRAP_ROOT_PASSWORD;
if (!rootEmail || !rootPassword) throw new Error('BOOTSTRAP_ROOT_EMAIL and BOOTSTRAP_ROOT_PASSWORD are required.');

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(staging.url, staging.serviceKey, clientOptions);
const root = createClient(staging.url, staging.publicKey, clientOptions);
const suffix = Date.now();
const adminEmail = `root-check-${suffix}@e2e.local`;
const adminPassword = 'Root-Check-Admin!2026';
const className = `Root Check ${suffix}`;
const studentId = `ROOTCHK${String(suffix).slice(-8)}`;
const studentPassword = 'Root-Check-Student!2026';
let adminId;
let studentUserId;

try {
  const rootLogin = await root.auth.signInWithPassword({ email: rootEmail, password: rootPassword });
  if (rootLogin.error) throw new Error(`Root sign-in failed: ${rootLogin.error.message}`);
  const [rootAuthority, adminAuthority] = await Promise.all([
    root.rpc('is_root_developer'),
    root.rpc('is_admin_aal2')
  ]);
  if (rootAuthority.error || rootAuthority.data !== true || adminAuthority.error || adminAuthority.data !== true) {
    throw new Error('Root authority was not recognized by the staging database.');
  }

  const adminCreation = await root.functions.invoke('manage-student', {
    body: { action: 'create-admin', email: adminEmail, name: 'Root Check Administrator', password: adminPassword }
  });
  if (adminCreation.error || !adminCreation.data?.id) {
    throw new Error(`Administrator creation check failed: ${adminCreation.data?.error || adminCreation.error?.message || 'unknown error'}`);
  }
  adminId = adminCreation.data.id;

  const admin = createClient(staging.url, staging.publicKey, clientOptions);
  const adminLogin = await admin.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  if (adminLogin.error) throw new Error(`Managed administrator sign-in failed: ${adminLogin.error.message}`);
  const adminAllowed = await admin.rpc('is_admin_aal2');
  const adminIsRoot = await admin.rpc('is_root_developer');
  if (adminAllowed.error || adminAllowed.data !== true || adminIsRoot.error || adminIsRoot.data !== false) {
    throw new Error('Managed administrator authority boundaries are incorrect.');
  }

  const classInsert = await service.from('classes').insert({ name: className, sections: ['A'] });
  if (classInsert.error) throw new Error(`Temporary class setup failed: ${classInsert.error.message}`);
  const studentCreation = await admin.functions.invoke('manage-student', {
    body: {
      action: 'create', studentId, name: 'Root Check Student', password: studentPassword,
      className, section: 'A'
    }
  });
  if (studentCreation.error || !studentCreation.data?.id) {
    throw new Error(`Student creation check failed: ${studentCreation.data?.error || studentCreation.error?.message || 'unknown error'}`);
  }
  studentUserId = studentCreation.data.id;

  const disable = await root.rpc('set_managed_administrator_enabled', {
    account_id_param: adminId,
    enabled_param: false
  });
  if (disable.error) throw new Error(`Administrator disable check failed: ${disable.error.message}`);
  const disabledAccess = await admin.rpc('is_admin_aal2');
  if (disabledAccess.error || disabledAccess.data !== false) throw new Error('Disabled administrator retained access.');

  const student = createClient(staging.url, staging.publicKey, clientOptions);
  const studentLogin = await student.auth.signInWithPassword({
    email: `${studentId.toLowerCase()}@students.examforge.invalid`, password: studentPassword
  });
  if (studentLogin.error) throw new Error(`Student sign-in failed: ${studentLogin.error.message}`);
  const studentRole = await student.rpc('get_my_role');
  if (studentRole.error || studentRole.data !== 'student') throw new Error('Student role verification failed.');

  console.log(JSON.stringify({
    verified: true,
    rootPasswordLogin: true,
    rootCreatesAdministrator: true,
    administratorCreatesStudent: true,
    disableRevokesAccess: true
  }));
} finally {
  if (studentUserId) await service.auth.admin.deleteUser(studentUserId);
  if (adminId) await service.auth.admin.deleteUser(adminId);
  await service.from('classes').delete().eq('name', className);
}
