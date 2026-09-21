import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('Connected staging rehearsal refuses to retrieve credentials without confirmation', () => {
  const result = spawnSync(process.execPath, ['scripts/rehearse-connected-staging.mjs'], {
    encoding: 'utf8', env: { ...process.env, REHEARSAL_CONFIRM_DISPOSABLE: '' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Explicit disposable staging confirmation is required/);
  assert.equal(result.stdout, '');
});

test('Connected rehearsal is bound to staging and uses verified MFA with privileged-user cleanup', () => {
  const source = readFileSync('scripts/rehearse-connected-staging.mjs', 'utf8')
    + readFileSync('scripts/connected-staging.mjs', 'utf8');
  assert.match(source, /const projectRef = 'vjynyashxomyryqjfkas'/);
  assert.doesNotMatch(source, /hetaoesxoicqreobjqpy|writeFile|stdio: 'inherit'/);
  assert.match(source, /randomBytes\(32\)/);
  assert.match(source, /currentLevel !== 'aal2'/);
  assert.match(source, /signOut\(\{ scope: 'global' \}\)/);
  assert.match(source, /deleteUser\(userId\)/);
  assert.doesNotMatch(source, /console\.(log|error)\((cli|keys|serviceKey|publicKey|refreshed)/);
});

test('Provisioning success requires persistent student and role records, not only an Auth ID', () => {
  const source = readFileSync('scripts/rehearse-staging.mjs', 'utf8');
  assert.match(source, /from\('students'\)\.select\('student_id, class, section'\)/);
  assert.match(source, /from\('profiles'\)\.select\('role'\)/);
  assert.match(source, /provisionedRole\?\.role !== 'student'/);
  assert.match(source, /Admin provisioning returned success without a usable/);
});

test('Staging rehearsal supports a bounded candidate load and reports latency percentiles', () => {
  const source = readFileSync('scripts/rehearse-staging.mjs', 'utf8');
  assert.match(source, /REHEARSAL_CANDIDATE_COUNT/);
  assert.match(source, /candidateCount > 1000/);
  assert.match(source, /latencyMs = \{ start: \[\], autosave: \[\], submit: \[\], retry: \[\], realtime: \[\] \}/);
  assert.match(source, /p95: percentile\(values, 95\)/);
});

test('Operator drill covers AAL1 denial, AAL2 lifecycle, factor recovery, health and audit', () => {
  const source = readFileSync('scripts/operator-drill-staging.mjs', 'utf8');
  assert.match(source, /AAL1 operator unexpectedly reached privileged health data/);
  assert.match(source, /preflight_validate_exam/);
  assert.match(source, /update\(\{ status: 'ENDED' \}\)/);
  assert.match(source, /admin\.mfa\.listFactors/);
  assert.match(source, /admin\.mfa\.deleteFactor/);
  assert.match(source, /admin_audit_events/);
  assert.match(source, /OPERATOR_DRILL_VERIFIED/);
});
