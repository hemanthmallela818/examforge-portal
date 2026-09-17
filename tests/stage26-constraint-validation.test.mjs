import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = resolve('supabase/migrations/20260917090000_stage26_validate_legacy_constraints.sql');
const migration = readFileSync(migrationPath, 'utf8');

test('Stage 26 validates every legacy NOT VALID application constraint forward-only', () => {
  const expected = [
    ['profiles', 'profiles_role_valid'],
    ['cbt_exams_raw', 'cbt_exams_status_valid'],
    ['classes', 'classes_data_valid'],
    ['question_bank', 'question_bank_data_valid'],
    ['cbt_exams_raw', 'cbt_exams_data_valid']
  ];

  for (const [table, constraint] of expected) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE public\\.${table}\\s+VALIDATE CONSTRAINT ${constraint};`),
      `${table}.${constraint} must be validated`
    );
  }

  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|CONSTRAINT)|DELETE\s+FROM|TRUNCATE/i);
});
