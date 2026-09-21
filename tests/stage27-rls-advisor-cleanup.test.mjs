import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20260919154854_optimize_rls_policy_execution.sql', import.meta.url);

test('Stage 27 caches auth lookups and removes overlapping SELECT policies', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /\(SELECT auth\.uid\(\)\)/);
  assert.match(sql, /\(SELECT public\.is_admin_aal2\(\)\)/);
  assert.match(sql, /\(SELECT public\.current_auth_session_id\(\)\)/);

  for (const table of ['profiles', 'classes', 'students', 'question_bank']) {
    assert.match(sql, new RegExp(`DROP POLICY IF EXISTS ${table === 'question_bank' ? 'question_bank_admin_aal2' : `${table}_admin_aal2`} ON public\\.${table}`));
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_admin_insert ON public\\.${table}`));
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_admin_update ON public\\.${table}`));
    assert.match(sql, new RegExp(`CREATE POLICY ${table}_admin_delete ON public\\.${table}`));
  }
});
