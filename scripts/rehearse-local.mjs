import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readLocalSupabase } from '../e2e/support/local-supabase.mjs';
import { generateTotp } from '../e2e/support/fixtures.mjs';

const local = readLocalSupabase();
const service = createClient(local.url, local.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const browser = createClient(local.url, local.anonKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const suffix = Date.now();
const email = `release-harness-${suffix}@e2e.local`;
const password = 'Release-Harness!2026';

const { data: created, error: createError } = await service.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { name: 'Local Release Harness Administrator' },
  app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
});
if (createError || !created?.user) throw createError || new Error('Could not create the local harness administrator.');

const { error: finalizeError } = await service.rpc('complete_account_provisioning', {
  account_id_param: created.user.id
});
if (finalizeError) throw finalizeError;

const { error: signInError } = await browser.auth.signInWithPassword({ email, password });
if (signInError) throw signInError;
const { data: enrollment, error: enrollmentError } = await browser.auth.mfa.enroll({ factorType: 'totp' });
if (enrollmentError || !enrollment?.id || !enrollment?.totp?.secret) {
  throw enrollmentError || new Error('Could not enroll local harness MFA.');
}
const { error: verificationError } = await browser.auth.mfa.challengeAndVerify({
  factorId: enrollment.id,
  code: generateTotp(enrollment.totp.secret)
});
if (verificationError) throw verificationError;
const { data: refreshed, error: refreshError } = await browser.auth.refreshSession();
if (refreshError || !refreshed?.session?.access_token) {
  throw refreshError || new Error('Could not refresh the local harness AAL2 session.');
}
const { data: assurance, error: assuranceError } = await browser.auth.mfa.getAuthenticatorAssuranceLevel();
if (assuranceError || assurance?.currentLevel !== 'aal2') {
  throw assuranceError || new Error('Local harness administrator did not reach AAL2.');
}

const result = spawnSync(process.execPath, [resolve('scripts/rehearse-staging.mjs')], {
  cwd: process.cwd(),
  stdio: 'inherit',
  timeout: 20 * 60 * 1000,
  env: {
    ...process.env,
    REHEARSAL_SUPABASE_URL: local.url,
    REHEARSAL_SUPABASE_ANON_KEY: local.anonKey,
    REHEARSAL_SUPABASE_SERVICE_ROLE_KEY: local.serviceRoleKey,
    REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN: refreshed.session.access_token,
    REHEARSAL_EXPECTED_PROJECT_REF: 'local',
    REHEARSAL_CONFIRM_DISPOSABLE: 'YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL'
  }
});

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Local release harness failed with exit code ${result.status}.`);
