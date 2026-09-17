import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_SCHEMA_VERSION,
  beginPendingSubmissionSync,
  clearOfflineRecoveryRecord,
  clearPendingSubmissionRecord,
  finishPendingSubmissionSync,
  formatPendingSubmissionPointerKey,
  formatPendingSubmissionStorageKey,
  readOfflineRecoveryRecord,
  readPendingSubmissionRecord,
  savePendingSubmissionRecord,
  savePendingTerminationRecord,
  readPendingTerminationRecord,
  clearPendingTerminationRecord
} from '../src/examLogic.js';
import { safeStorageGet, safeStorageJson, safeStorageRemove, safeStorageSet } from '../src/browserStorage.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const studentA = { id: 'STU-001', docId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const studentB = { id: 'STU-002', docId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const examId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const responses = [{ question_id: 'q1', selected_option: '0', status: 'ANSWERED' }];

test('safe browser storage helpers tolerate unavailable and corrupt storage', () => {
  const storage = new MemoryStorage();
  assert.equal(safeStorageSet(storage, 'value', JSON.stringify({ ok: true })), true);
  assert.deepEqual(safeStorageJson(storage, 'value'), { ok: true });
  storage.setItem('value', '{broken');
  assert.equal(safeStorageJson(storage, 'value'), null);
  assert.equal(safeStorageRemove(storage, 'value'), true);
  assert.equal(safeStorageGet(storage, 'value'), null);

  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  assert.equal(safeStorageGet(blocked, 'value'), null);
  assert.equal(safeStorageSet(blocked, 'value', 'x'), false);
  assert.equal(safeStorageRemove(blocked, 'value'), false);
});

test('pending submissions for the same exam are isolated per student', () => {
  const storage = new MemoryStorage();
  assert.equal(savePendingSubmissionRecord({ student: studentA, examId, responses, storage }).success, true);
  assert.equal(savePendingSubmissionRecord({ student: studentB, examId, responses: [], storage }).success, true);

  assert.deepEqual(readPendingSubmissionRecord({ student: studentA, storage }).responses, responses);
  assert.deepEqual(readPendingSubmissionRecord({ student: studentB, storage }).responses, []);

  clearPendingSubmissionRecord({ student: studentA, examId, storage });
  assert.equal(readPendingSubmissionRecord({ student: studentA, storage }), null);
  assert.deepEqual(readPendingSubmissionRecord({ student: studentB, storage }).responses, []);
});

test('a foreign legacy submission is neither restored nor deleted', () => {
  const storage = new MemoryStorage();
  const legacyKey = `cbt_pending_submission_${examId}`;
  const foreign = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    examId,
    studentId: studentB.id,
    userUuid: studentB.docId,
    responses
  };
  storage.setItem('cbt_pending_submission_id', examId);
  storage.setItem(legacyKey, JSON.stringify(foreign));

  assert.equal(readPendingSubmissionRecord({ student: studentA, storage }), null);
  assert.equal(storage.getItem(legacyKey), JSON.stringify(foreign));
  clearPendingSubmissionRecord({ student: studentA, examId, storage });
  assert.equal(storage.getItem(legacyKey), JSON.stringify(foreign));
});

test('an owned legacy submission is migrated to the scoped format', () => {
  const storage = new MemoryStorage();
  storage.setItem('cbt_pending_submission_id', examId);
  storage.setItem(`cbt_pending_submission_${examId}`, JSON.stringify({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    examId,
    studentId: studentA.id,
    userUuid: studentA.docId,
    responses
  }));

  const restored = readPendingSubmissionRecord({ student: studentA, storage });
  assert.deepEqual(restored.responses, responses);
  assert.equal(storage.getItem(`cbt_pending_submission_${examId}`), null);
  assert.equal(storage.getItem('cbt_pending_submission_id'), null);
  assert.ok(storage.getItem(formatPendingSubmissionStorageKey(studentA.docId, examId)));
  assert.equal(storage.getItem(formatPendingSubmissionPointerKey(studentA.docId)), examId);
});

test('blocked browser storage fails closed without throwing', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  assert.equal(readPendingSubmissionRecord({ student: studentA, storage: blocked }), null);
  assert.equal(readOfflineRecoveryRecord({ student: studentA, examId, storage: blocked }), null);
  assert.equal(savePendingSubmissionRecord({ student: studentA, examId, responses, storage: blocked }).success, false);
  assert.doesNotThrow(() => clearPendingSubmissionRecord({ student: studentA, examId, storage: blocked }));
});

test('a partial storage failure rolls back without destroying the last valid submission', () => {
  const storage = new MemoryStorage();
  assert.equal(savePendingSubmissionRecord({ student: studentA, examId, responses, storage }).success, true);
  const recordKey = formatPendingSubmissionStorageKey(studentA.docId, examId);
  const pointerKey = formatPendingSubmissionPointerKey(studentA.docId);
  const originalRecord = storage.getItem(recordKey);
  const originalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === pointerKey) throw new Error('quota reached');
    originalSet(key, value);
  };

  const failed = savePendingSubmissionRecord({ student: studentA, examId, responses: [], storage });
  assert.equal(failed.success, false);
  assert.equal(storage.getItem(recordKey), originalRecord);
  assert.equal(storage.getItem(pointerKey), examId);
});

test('pending terminations are isolated and cleared only for their owner', () => {
  const storage = new MemoryStorage();
  assert.equal(savePendingTerminationRecord({ student: studentA, examId, storage }), true);
  assert.equal(savePendingTerminationRecord({ student: studentB, examId: 'exam-b', storage }), true);
  assert.equal(readPendingTerminationRecord({ student: studentA, storage }).examId, examId);
  assert.equal(readPendingTerminationRecord({ student: studentB, storage }).examId, 'exam-b');
  clearPendingTerminationRecord({ student: studentA, storage });
  assert.equal(readPendingTerminationRecord({ student: studentA, storage }), null);
  assert.equal(readPendingTerminationRecord({ student: studentB, storage }).examId, 'exam-b');
});

test('completion cleanup does not erase another student recovery mirror', () => {
  const storage = new MemoryStorage();
  const foreignMirror = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    examId,
    studentId: studentB.docId,
    userUuid: studentB.docId,
    activeExam: { id: examId },
    endTime: Date.now() + 60_000
  };
  storage.setItem('cbt_active_exam_session', JSON.stringify(foreignMirror));

  clearOfflineRecoveryRecord({ student: studentA, examId, storage });
  assert.equal(storage.getItem('cbt_active_exam_session'), JSON.stringify(foreignMirror));
  clearOfflineRecoveryRecord({ student: studentB, examId, storage });
  assert.equal(storage.getItem('cbt_active_exam_session'), null);
});

test('pending submission synchronization is single-flight per student and exam', () => {
  assert.equal(beginPendingSubmissionSync({ student: studentA, examId }), true);
  assert.equal(beginPendingSubmissionSync({ student: studentA, examId }), false);
  assert.equal(beginPendingSubmissionSync({ student: studentB, examId }), true);
  finishPendingSubmissionSync({ student: studentA, examId });
  assert.equal(beginPendingSubmissionSync({ student: studentA, examId }), true);
  finishPendingSubmissionSync({ student: studentA, examId });
  finishPendingSubmissionSync({ student: studentB, examId });
});
