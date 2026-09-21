// Operator-only harness. Credentials remain in memory, never in files or logs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { generateTotp } from '../e2e/support/fixtures.mjs';
import { readConnectedStaging } from './connected-staging.mjs';

const { projectRef, confirmation, serviceKey, publicKey, url } = readConnectedStaging();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(url, serviceKey, options);
const browser = createClient(url, publicKey, options);
let userId;
let phase = 'administrator creation';
let failed = false;
const requireSuccess = result => {
  if (result.error) throw new Error('Operation failed.');
  return result.data;
};
try {
  const email = `release-harness-${Date.now()}@rehearsal.local`;
  const password = `${randomBytes(32).toString('base64url')}!aA1`;
  const created = requireSuccess(await service.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name: 'Disposable Staging Rehearsal Administrator' },
    app_metadata: { provisioned_by: 'admin', account_type: 'admin' }
  }));
  userId = created.user.id;
  phase = 'administrator provisioning';
  requireSuccess(await service.rpc('complete_account_provisioning', { account_id_param: userId }));
  phase = 'administrator sign-in';
  requireSuccess(await browser.auth.signInWithPassword({ email, password }));
  phase = 'MFA enrollment';
  const enrollment = requireSuccess(await browser.auth.mfa.enroll({ factorType: 'totp' }));
  phase = 'MFA verification';
  requireSuccess(await browser.auth.mfa.challengeAndVerify({
    factorId: enrollment.id, code: generateTotp(enrollment.totp.secret)
  }));
  const refreshed = requireSuccess(await browser.auth.refreshSession());
  const assurance = requireSuccess(await browser.auth.mfa.getAuthenticatorAssuranceLevel());
  if (assurance.currentLevel !== 'aal2') throw new Error('AAL2 verification failed.');
  console.log(`Staging connection and temporary administrator MFA verified. Starting ${process.env.REHEARSAL_CANDIDATE_COUNT || '80'}-candidate rehearsal.`);
  phase = 'candidate rehearsal';
  const outcome = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve('scripts/rehearse-staging.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60 * 1000,
      env: { ...process.env,
        REHEARSAL_SUPABASE_URL: url, REHEARSAL_SUPABASE_ANON_KEY: publicKey,
        REHEARSAL_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
        REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN: refreshed.session.access_token,
        REHEARSAL_EXPECTED_PROJECT_REF: projectRef, REHEARSAL_CONFIRM_DISPOSABLE: confirmation
        , REHEARSAL_CANDIDATE_COUNT: process.env.REHEARSAL_CANDIDATE_COUNT || '80'
      }
    });
    let output = '';
    child.stdout.on('data', data => { output = (output + data).slice(-32_000); });
    // Do not relay SDK error objects, which may contain authentication headers.
    child.stderr.resume();
    child.on('error', rejectRun);
    child.on('close', code => resolveRun({ code, output }));
  });
  if (outcome.code !== 0) throw new Error('Candidate rehearsal failed. Inspect staging metrics, not credential-bearing logs.');
  const report = JSON.parse(outcome.output.trim().split(/\r?\n/).at(-1));
  console.log(JSON.stringify(report));
} catch {
  console.error(`Staging rehearsal failed during ${phase}. Credentials were not logged.`);
  failed = true;
} finally {
  // Revoke refresh sessions before deleting the temporary privileged identity.
  const signedOut = await browser.auth.signOut({ scope: 'global' });
  if (signedOut.error) { console.error('Temporary administrator sign-out needs investigation.'); failed = true; }
  if (userId) {
    const removed = await service.auth.admin.deleteUser(userId);
    if (removed.error) { console.error('Temporary administrator cleanup needs investigation.'); failed = true; }
    else console.log('Temporary staging administrator removed. Candidate fixtures still require staging cleanup.');
  }
}
process.exitCode = failed ? 1 : 0;
