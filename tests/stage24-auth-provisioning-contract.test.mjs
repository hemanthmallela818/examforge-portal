import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Stage 24 provisioning tolerates GoTrue insert ordering and finalizes only through service role', async () => {
  const [migration, edgeFunction, bootstrap, e2eSetup] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260913090000_stage24_auth_provisioning_compatibility.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-student/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/bootstrap-admin.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../e2e/global-setup.mjs', import.meta.url), 'utf8')
  ]);

  assert.match(migration, /RETURN NEW;[\s\S]*Public sign-up is disabled|Public sign-up is disabled[\s\S]*RETURN NEW;/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.complete_account_provisioning\(account_id_param uuid\)/);
  assert.match(migration, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(migration, /missing its server-owned provisioning marker/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.complete_account_provisioning\(uuid\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.complete_account_provisioning\(uuid\) TO service_role/);
  assert.match(edgeFunction, /admin\.rpc\('complete_account_provisioning'/);
  assert.match(edgeFunction, /finalizeError \|\| verifyStudentError \|\| !verifiedStudent/);
  assert.match(bootstrap, /admin\.rpc\('complete_account_provisioning'/);
  assert.match(bootstrap, /deleteUser\(user\.id\)/);
  assert.match(bootstrap, /from\('application_owner'\)\.upsert/);
  assert.match(e2eSetup, /complete_account_provisioning/);
});
