import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readExamSourceSync } from './support/examSource.mjs';

test('Stage 12: Staging rehearsal script enforces concurrency, backoff, and isolation contracts', () => {
  const rehearsalPath = resolve('scripts/rehearse-staging.mjs');
  assert.ok(existsSync(rehearsalPath), 'scripts/rehearse-staging.mjs must exist');

  const content = readFileSync(rehearsalPath, 'utf8');

  // 1. Concurrency: the bounded candidate count defaults to at least 80.
  assert.match(content, /candidateCount\s*=\s*Number\.parseInt\(process\.env\.REHEARSAL_CANDIDATE_COUNT\s*\|\|\s*'80'/, 'Rehearsal script must default to at least 80 candidates');

  // 2. Retry and backoff: Handles 429 rate-limiting from shared IP
  assert.match(content, /withRetries\s*=/, 'Rehearsal script must define retry wrapper');
  assert.match(content, /429/, 'Rehearsal retry wrapper must specifically handle HTTP 429 rate limiting');

  // 3. Security: Answer key isolation verification
  assert.match(content, /correctAnswer|correct_answer/, 'Rehearsal script must verify answer keys are hidden from candidates');
  assert.match(content, /Answer key was exposed to a student/, 'Script must throw if answer key leaks to student client');

  // 4. Boundary protection: Unauthorized writes and student provisioning blocked
  assert.match(content, /unauthorizedWriteBlocked/, 'Rehearsal script must test and block unauthorized result writes');
  assert.match(content, /unauthorizedExamWriteBlocked/, 'Rehearsal script must test and block unauthorized exam creation');
  assert.match(content, /studentProvisioningBlocked/, 'Rehearsal script must verify students cannot invoke student provisioning');

  // 5. Safety: bind to an explicitly confirmed disposable project and never
  // pretend immutable academic records were deleted.
  assert.match(content, /REHEARSAL_EXPECTED_PROJECT_REF/, 'Rehearsal must bind to the intended project ref');
  assert.match(content, /YES_RESET_THIS_DISPOSABLE_PROJECT_AFTER_REHEARSAL/, 'Rehearsal must require destructive staging confirmation');
  assert.match(content, /REHEARSAL_ADMIN_AAL2_ACCESS_TOKEN/, 'Positive admin checks require a verified AAL2 token');
  assert.match(content, /claim_student_session/, 'Candidates must claim the signed Auth session through the RPC');
  assert.match(content, /sync_active_session_progress/, 'Rehearsal must exercise autosave concurrency');
  assert.doesNotMatch(content, /update\(\{\s*session_token/, 'Removed browser-owned session token must not be written');
  assert.match(content, /stagingResetRequired:\s*true/, 'Immutable rehearsal results must require a staging reset');
  assert.doesNotMatch(content, /cleanupCompleted\s*=\s*true/, 'Harness must not falsely claim immutable records were deleted');
});

test('Stage 12: Single active device enforcement and session token binding contracts', () => {
  const authPortalPath = resolve('src/components/AuthPortal.jsx');
  const authContent = readFileSync(authPortalPath, 'utf8');

  // Candidate login claims session via RPC
  assert.match(authContent, /claim_student_session/, 'AuthPortal must call claim_student_session RPC on student login');
  assert.match(authContent, /sessionToken|session_id/, 'AuthPortal must store claimed session token');

  const appContent = readExamSourceSync();

  // App intercepts replaced session error and preserves attempt work
  assert.match(appContent, /isStudentSessionReplaced/, 'App.jsx must check for session replacement');
  assert.match(appContent, /preserveAttempt:\s*true/, 'Session replacement logout must preserve candidate local work');
});

test('Stage 12: Production readiness documentation records resolution of all P0 blockers', () => {
  const auditPath = resolve('PRODUCTION_READINESS_AUDIT_2026-09-10.md');
  const reportPath = resolve('PRODUCTION_READINESS_REPORT.md');

  assert.ok(existsSync(auditPath), 'PRODUCTION_READINESS_AUDIT_2026-09-10.md must exist');
  assert.ok(existsSync(reportPath), 'PRODUCTION_READINESS_REPORT.md must exist');

  const auditContent = readFileSync(auditPath, 'utf8');
  const reportContent = readFileSync(reportPath, 'utf8');

  // Verify resolution of key architecture gates
  assert.match(auditContent, /Stages 1 through 11|Stages 1[–-]11/i, 'Audit must reference completion of Stages 1 through 11');
  assert.match(auditContent, /MFA|AAL2/i, 'Audit must document AAL2 MFA resolution');
  assert.match(auditContent, /Point-in-Time Recovery|PITR/i, 'Audit must document backup/PITR resolution');
  assert.match(reportContent, /rehearse-staging\.mjs/i, 'Report must reference the staging rehearsal harness');
});

test('Stage 12: Full operational script suite declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

  assert.ok(pkg.scripts['test:rehearsal'], 'package.json must declare "test:rehearsal"');
  assert.ok(pkg.scripts['ops:check'], 'package.json must declare "ops:check"');
  assert.ok(pkg.scripts['admin:bootstrap'], 'package.json must declare "admin:bootstrap"');
});
