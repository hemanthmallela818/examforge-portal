import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('CI workflow file exists and configures full quality gates', () => {
  const ciPath = resolve('.github/workflows/ci.yml');
  assert.ok(existsSync(ciPath), '.github/workflows/ci.yml must exist');

  const ciContent = readFileSync(ciPath, 'utf8');

  // Verify triggers
  assert.match(ciContent, /on:\s*[\s\S]*?push:\s*[\s\S]*?branches:\s*\[\s*main\s*\]/i, 'CI must trigger on push to main');
  assert.match(ciContent, /pull_request:\s*[\s\S]*?branches:\s*\[\s*main\s*\]/i, 'CI must trigger on PR to main');

  // Verify mandatory gates
  assert.match(ciContent, /npm run lint/, 'CI must run npm run lint');
  assert.match(ciContent, /npm run test:coverage/, 'CI must run the coverage-gated test suite');
  assert.match(ciContent, /npm run build/, 'CI must run npm run build');
  assert.match(ciContent, /npm audit/, 'CI must run npm audit');
  assert.match(ciContent, /permissions:\s*[\s\S]*?contents:\s*read/i, 'CI token permissions must be read-only');
  assert.match(ciContent, /timeout-minutes:\s*20/i, 'CI jobs must have a finite timeout');
  assert.match(ciContent, /cancel-in-progress:\s*true/i, 'Superseded CI runs should be cancelled');
});

test('operational health check CLI script exists, is executable, and supports --help and --json', () => {
  const scriptPath = resolve('scripts/operational-health-check.mjs');
  assert.ok(existsSync(scriptPath), 'scripts/operational-health-check.mjs must exist');

  const scriptContent = readFileSync(scriptPath, 'utf8');
  assert.match(scriptContent, /--help/i, 'Script must support --help flag');
  assert.match(scriptContent, /--json/i, 'Script must support --json flag');
  assert.match(scriptContent, /admin_operational_health/i, 'Script must query admin_operational_health');
  assert.match(scriptContent, /get_unreferenced_exam_assets/i, 'Script must scan for unreferenced storage assets');
  assert.doesNotMatch(scriptContent, /VITE_SUPABASE_ANON_KEY/, 'Privileged health checks must never fall back to an anonymous key');
  assert.match(scriptContent, /Authoritative operational health check failed/, 'Denied authoritative checks must make health fail');
  assert.match(scriptContent, /Storage integrity scan failed/, 'A failed storage scan must make health fail');
});

test('disaster recovery documentation covers PITR, offline recovery, storage cleanup, and MFA rotation', () => {
  const docPath = resolve('docs/OPERATIONS_AND_DISASTER_RECOVERY.md');
  assert.ok(existsSync(docPath), 'docs/OPERATIONS_AND_DISASTER_RECOVERY.md must exist');

  const docContent = readFileSync(docPath, 'utf8');
  assert.match(docContent, /Point-in-Time Recovery|PITR/i, 'Documentation must specify PITR recovery procedures');
  assert.match(docContent, /pg_dump/i, 'Documentation must specify logical pg_dump backup commands');
  assert.match(docContent, /exam-assets/i, 'Documentation must cover storage asset backup');
  assert.match(docContent, /Runbook 1: Campus-Wide Internet Outage/i, 'Documentation must specify internet blackout recovery');
  assert.match(docContent, /Runbook 2: Candidate Machine Hardware Failure/i, 'Documentation must specify device swap procedure');
  assert.match(docContent, /Runbook 3: Unreferenced Storage Asset Purge/i, 'Documentation must specify storage asset purge procedure');
  assert.match(docContent, /Administrator MFA Key Rotation/i, 'Documentation must cover lost TOTP MFA factor recovery');
  assert.match(docContent, /Browser storage is not encrypted/i, 'Documentation must accurately describe browser-storage confidentiality');
  assert.match(docContent, /do not follow the student to another device/i, 'Documentation must not promise cross-device local recovery');
  assert.doesNotMatch(docContent, /DELETE FROM auth\.mfa_factors/i, 'Runbook must not recommend direct Auth schema mutation');
});

test('package.json defines operational and linting commands', () => {
  const pkgPath = resolve('package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert.ok(pkg.scripts['lint'], 'package.json must declare a "lint" script');
  assert.ok(pkg.scripts['ops:check'], 'package.json must declare an "ops:check" script');
  assert.ok(pkg.scripts['ops:check:main'], 'package.json must declare a production health-check script');
  assert.ok(pkg.scripts['build'], 'package.json must declare a "build" script');
  assert.ok(pkg.scripts['test'], 'package.json must declare a "test" script');
});

test('Vercel deployment is pinned to the production backend with defensive headers', () => {
  const config = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
  assert.equal(config.framework, 'vite');
  assert.equal(config.outputDirectory, 'dist');

  const globalHeaders = config.headers.find(entry => entry.source === '/(.*)')?.headers || [];
  const headers = new Map(globalHeaders.map(({ key, value }) => [key.toLowerCase(), value]));
  const csp = headers.get('content-security-policy') || '';

  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /https:\/\/hetaoesxoicqreobjqpy\.supabase\.co/);
  assert.doesNotMatch(csp, /https?:\/\/\*/);
  assert.equal(headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains; preload');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('permissions-policy') || '', /camera=\(\)/);
});
