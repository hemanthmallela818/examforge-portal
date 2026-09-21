import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const harness = readFileSync(resolve('scripts/rehearse-staging.mjs'), 'utf8');
const localRunner = readFileSync(resolve('scripts/rehearse-local.mjs'), 'utf8');
const localSupabaseFixture = readFileSync(resolve('e2e/support/local-supabase.mjs'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const healthCheck = readFileSync(resolve('scripts/operational-health-check.mjs'), 'utf8');
const advisorCleanup = readFileSync(resolve('supabase/migrations/20260913110000_stage25_database_advisor_cleanup.sql'), 'utf8');
const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const supabaseRunner = readFileSync(resolve('scripts/run-supabase.mjs'), 'utf8');
const restoreProof = readFileSync(resolve('scripts/prove-local-backup-restore.mjs'), 'utf8');
const storageRestoreProof = readFileSync(resolve('scripts/prove-local-storage-restore.mjs'), 'utf8');
const supabaseConfig = readFileSync(resolve('supabase/config.toml'), 'utf8');

test('Stage 25 local runner is restricted to the local Supabase stack and creates an AAL2 administrator', () => {
  assert.match(localRunner, /readLocalSupabase\(\)/);
  assert.match(localRunner, /account_type: 'admin'/);
  assert.match(localRunner, /complete_account_provisioning/);
  assert.match(localRunner, /challengeAndVerify/);
  assert.match(localRunner, /REHEARSAL_EXPECTED_PROJECT_REF: 'local'/);
  assert.equal(pkg.scripts['test:rehearsal:local'], 'node scripts/rehearse-local.mjs');
});

test('Stage 25 browser fixtures allow only host-local Supabase endpoints', () => {
  assert.match(localSupabaseFixture, /127\.0\.0\.1/);
  assert.match(localSupabaseFixture, /localhost/);
  assert.match(localSupabaseFixture, /host\.docker\.internal/);
  assert.match(localSupabaseFixture, /Refusing to run E2E fixtures against a non-local Supabase host/);
});

test('Stage 25 harness verifies unique candidate grading, retry idempotence, isolation, and exact cardinality', () => {
  assert.match(harness, /REHEARSAL_CANDIDATE_COUNT/);
  assert.match(harness, /candidateCount > 1000/);
  assert.match(harness, /const questionCount = Math\.max\(80, candidateCount\)/);
  assert.match(harness, /responsesForCandidate/);
  assert.match(harness, /complete_account_provisioning/);
  assert.match(harness, /idempotentSubmissionRetries/);
  assert.match(harness, /zeroLostOrCrossAccountAnswers/);
  assert.match(harness, /zeroDuplicateResults/);
  assert.match(harness, /zeroUnhandledServerErrors/);
  assert.match(harness, /crossAccountSessionsHidden/);
  assert.match(harness, /crossAccountResultsHidden/);
  assert.match(harness, /resultCount !== students\.length/);
  assert.match(harness, /sessionCount !== 0/);
});

test('Stage 25 staging runner keeps remote targeting exact and explicitly disposable', () => {
  assert.match(harness, /rehearsalHost !== `\$\{expectedProjectRef\}\.supabase\.co`/);
  assert.match(harness, /YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL/);
  assert.match(harness, /cleanupCompleted:\s*false/);
  assert.match(harness, /stagingResetRequired:\s*true/);
});

test('Stage 25 operational health check has a local-only release-gate mode', () => {
  assert.match(healthCheck, /process\.argv\.includes\('--local'\)/);
  assert.match(healthCheck, /readLocalSupabase\(\)/);
  assert.equal(pkg.scripts['ops:check:local'], 'node scripts/operational-health-check.mjs --local --json');
});

test('Stage 25 database advisor cleanup is forward-only, fail-closed, and behavior-preserving', () => {
  assert.match(advisorCleanup, /pg_get_functiondef/);
  assert.match(advisorCleanup, /Unexpected sanitize_exam_responses definition/);
  assert.match(advisorCleanup, /Unexpected preflight_validate_exam definition/);
  assert.match(advisorCleanup, /Unexpected start_exam_session_stage3_internal definition/);
  assert.match(advisorCleanup, /PERFORM exam_data_param, responses_param/);
  assert.doesNotMatch(advisorCleanup, /DROP FUNCTION|REVOKE|GRANT/);
});

test('Stage 25 local backup proof restores into an isolated database and verifies critical relations', () => {
  assert.equal(pkg.scripts['ops:prove-restore:local'], 'node scripts/prove-local-backup-restore.mjs');
  assert.match(restoreProof, /pg_dump/);
  assert.match(restoreProof, /pg_restore/);
  assert.match(restoreProof, /--no-owner/);
  assert.match(restoreProof, /--no-privileges/);
  assert.match(restoreProof, /--template=template0/);
  assert.match(restoreProof, /RESTORE_VERIFIED/);
  assert.match(restoreProof, /cbt_restore_proof_/);
  assert.match(restoreProof, /unvalidatedPublicConstraints/);
  assert.doesNotMatch(restoreProof, /SUPABASE_ACCESS_TOKEN|\.supabase\.co/);
});

test('Stage 25 private-file proof exports, restores, hashes, and cleans a local private asset', () => {
  assert.equal(pkg.scripts['ops:prove-storage-restore:local'], 'node scripts/prove-local-storage-restore.mjs');
  assert.match(storageRestoreProof, /exam-assets/);
  assert.match(storageRestoreProof, /bucket\.public/);
  assert.match(storageRestoreProof, /getPublicUrl/);
  assert.match(storageRestoreProof, /createSignedUrl/);
  assert.match(storageRestoreProof, /sha256/);
  assert.match(storageRestoreProof, /PRIVATE_STORAGE_RESTORE_VERIFIED/);
  assert.match(storageRestoreProof, /finally/);
});

test('Stage 25 local stack disables the unsupported Windows analytics log collector', () => {
  assert.match(supabaseConfig, /\[analytics\]\s*(?:#[^\n]*\n)*enabled\s*=\s*false/);
});

test('Stage 25 CI replays local Supabase and runs authenticated critical paths in every browser', () => {
  assert.match(ciWorkflow, /critical-browser-e2e:/);
  assert.equal(pkg.devDependencies.supabase, '2.117.0');
  assert.match(ciWorkflow, /node scripts\/run-supabase\.mjs start/);
  assert.match(ciWorkflow, /node scripts\/run-supabase\.mjs db reset --local/);
  assert.match(supabaseRunner, /SUPABASE_TELEMETRY_DISABLED: '1'/);
  assert.match(supabaseRunner, /DO_NOT_TRACK: '1'/);
  assert.match(ciWorkflow, /playwright install --with-deps chromium firefox webkit/);
  assert.match(ciWorkflow, /npm run test:e2e:critical/);
  assert.match(ciWorkflow, /if: always\(\)/);
});
