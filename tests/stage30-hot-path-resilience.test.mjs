import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { edgeSource } from './support/edgeSource.mjs';
import { stableStringify, sameResponses, isTransientRpcError, retryDelayMs } from '../src/examLogic.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('response comparison ignores jsonb key order but detects real changes', () => {
  const client = { Physics: [{ selectedOption: 1, status: 'ANSWERED' }], Chemistry: [] };
  const server = { Chemistry: [], Physics: [{ status: 'ANSWERED', selectedOption: 1 }] };
  assert.equal(stableStringify(client), stableStringify(server));
  assert.ok(sameResponses(client, server));
  assert.ok(!sameResponses(client, { ...server, Physics: [{ status: 'ANSWERED', selectedOption: 2 }] }));
  assert.ok(sameResponses({ a: 1, b: undefined }, { a: 1 }));
});

test('only transient failures are retried', () => {
  for (const status of [429, 502, 503, 504]) assert.ok(isTransientRpcError({ httpStatus: status }), `HTTP ${status}`);
  for (const code of ['55P03', '57014', 'PGRST003', '40P01']) assert.ok(isTransientRpcError({ code }), code);
  assert.ok(isTransientRpcError({ message: 'TypeError: Failed to fetch' }));
  assert.ok(isTransientRpcError(null, { online: false }));
  assert.ok(!isTransientRpcError({ httpStatus: 400, code: 'P0001', message: 'This exam is not available for submission' }));
  assert.ok(!isTransientRpcError({ code: '42501', message: 'This student session has been replaced or is no longer active' }));
  assert.ok(!isTransientRpcError(null));
});

test('retry delays use capped full jitter', () => {
  assert.equal(retryDelayMs(1, { random: () => 0 }), 500);
  assert.equal(retryDelayMs(1, { random: () => 1 }), 1000);
  assert.equal(retryDelayMs(10, { random: () => 1 }), 8000);
  assert.ok(retryDelayMs(3, { random: () => 0.5 }) <= 4000);
});

test('hot-path migration keeps submission server-authoritative and finalization deadlock-safe', async () => {
  const sql = await read('supabase/migrations/20260924130000_exam_hot_path_hardening.sql');
  assert.match(sql, /expected_version_param pg_catalog\.int4 DEFAULT NULL/);
  assert.match(sql, /IF expected_version_param IS NOT NULL THEN\s+RETURN public\.submit_exam_stage3_internal\(exam_id_param, NULL\)/);
  assert.match(sql, /EXCEPTION WHEN OTHERS THEN[\s\S]*?public\.student_results AS r[\s\S]*?RAISE;/);
  // Advisory lock before row lock, never waiting, one sub-transaction per attempt.
  assert.match(sql, /pg_try_advisory_xact_lock[\s\S]*?FOR UPDATE NOWAIT/);
  assert.match(sql, /WHEN lock_not_available THEN/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.finalize_expired_sessions_internal[\s\S]*?FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.run_scheduled_session_finalization\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /cron\.schedule\(\s*'examforge-finalize-expired-sessions',\s*'\* \* \* \* \*'/);
  assert.match(sql, /ALTER ROLE authenticated SET lock_timeout = '5s'/);
  // Grace comparison must be parenthesised: OPERATOR() syntax shares one precedence level.
  assert.match(sql, /deadline_at OPERATOR\(pg_catalog\.<=\) \(\s*pg_catalog\.clock_timestamp\(\) OPERATOR\(pg_catalog\.-\)/);
});

test('clearing the question bank is root-developer-only', async () => {
  const sql = await read('supabase/migrations/20260924120000_root_only_question_bank_clear.sql');
  assert.match(sql, /IF NOT public\.is_root_developer\(\) THEN\s+RAISE EXCEPTION 'Root developer access is required'/);
});

test('password resets are audited, blocked for archived students, and errors carry correlation IDs', async () => {
  const edge = await edgeSource();
  assert.match(edge, /action: 'RESET_STUDENT_PASSWORD'/);
  assert.match(edge, /Reactivate this student before resetting the password/);
  assert.match(edge, /correlationId = typeof record\.correlationId === 'string' \? record\.correlationId : crypto\.randomUUID\(\)/);
  assert.match(edge, /'X-Correlation-Id': correlationId/);
  assert.doesNotMatch(edge, /metadata: \{[^}]*password/);
});

test('a shared machine never keeps another student\'s rejected recovery copy', async () => {
  const { saveOfflineRecoveryRecord, readOfflineRecoveryRecord } = await import('../src/examLogic.js');
  const memory = new Map();
  const storage = {
    getItem: key => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key)
  };
  const studentA = { id: 'STU-A', docId: 'a1111111-1111-4111-8111-111111111111' };
  const studentB = { id: 'STU-B', docId: 'b2222222-2222-4222-8222-222222222222' };

  const saved = saveOfflineRecoveryRecord({ student: studentA, examId: 'exam-1', userUuid: studentA.docId, userResponses: { Physics: [] }, storage });
  assert.equal(saved.success, true, 'the injected storage is used');
  assert.ok(memory.has('cbt_active_exam_session'));

  // Student B on the same machine: A's scoped record is not B's, only the shared mirror is found.
  assert.equal(readOfflineRecoveryRecord({ student: studentB, examId: 'exam-1', userUuid: studentB.docId, storage }), null);
  assert.equal(memory.has('cbt_active_exam_session'), false, 'the foreign shared copy is deleted');
});
