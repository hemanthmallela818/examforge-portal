import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubmissionResponses,
  createInitialResponses,
  remainingSecondsUntil,
  sessionBelongsToStudent,
  saveOfflineRecoveryRecord,
  reconcileOfflineRecovery
} from '../src/examLogic.js';

const exam = {
  subjects: ['Physics', 'Mathematics'],
  questions: {
    Physics: [{ id: 'p1' }, { id: 'p2' }],
    Mathematics: [{ id: 'm1' }]
  }
};

test('initial response state covers every question and marks only the first visited', () => {
  assert.deepEqual(createInitialResponses(exam), {
    Physics: [
      { selectedOption: null, status: 'NOT_ANSWERED' },
      { selectedOption: null, status: 'NOT_VISITED' }
    ],
    Mathematics: [{ selectedOption: null, status: 'NOT_VISITED' }]
  });
});

test('initial response state tolerates missing and empty exam data', () => {
  assert.deepEqual(createInitialResponses(undefined), {});
  assert.deepEqual(createInitialResponses({ subjects: ['Physics'], questions: {} }), { Physics: [] });
});

test('submission payload preserves zero, numeric text, and marked-answer state', () => {
  const payload = buildSubmissionResponses(exam, {
    Physics: [
      { selectedOption: 0, status: 'ANSWERED' },
      { selectedOption: null, status: 'MARKED' }
    ],
    Mathematics: [{ selectedOption: '-0.50', status: 'ANSWERED_MARKED' }]
  });
  assert.deepEqual(payload, [
    { question_id: 'p1', selected_option: 0, status: 'ANSWERED' },
    { question_id: 'p2', selected_option: null, status: 'MARKED' },
    { question_id: 'm1', selected_option: '-0.50', status: 'ANSWERED_MARKED' }
  ]);
});

test('submission payload rejects unknown status values and questions without IDs', () => {
  const payload = buildSubmissionResponses(
    { subjects: ['S'], questions: { S: [{ id: '' }, { id: 'valid' }] } },
    { S: [{ selectedOption: 'x', status: 'FORGED' }, { selectedOption: 2, status: 'FORGED' }] }
  );
  assert.deepEqual(payload, [
    { question_id: 'valid', selected_option: 2, status: 'NOT_VISITED' }
  ]);
});

test('offline recovery records cannot cross student accounts', () => {
  const record = { studentId: 'auth-user-1' };
  assert.equal(sessionBelongsToStudent(record, { docId: 'auth-user-1', id: 'PUBLIC-1' }), true);
  assert.equal(sessionBelongsToStudent(record, { docId: 'auth-user-2', id: 'PUBLIC-2' }), false);
  assert.equal(sessionBelongsToStudent(record, null), false);
});

test('exam countdown catches up after browser suspension', () => {
  assert.equal(remainingSecondsUntil(106_001, 100_000), 7);
  assert.equal(remainingSecondsUntil(99_999, 100_000), 0);
  assert.equal(remainingSecondsUntil('invalid', 100_000), 0);
});

test('recovery reconciliation overlays local answers only at the exact server version', () => {
  const server = createInitialResponses(exam);
  const local = structuredClone(server);
  local.Physics[0] = { selectedOption: 2, status: 'ANSWERED' };

  const sameVersion = reconcileOfflineRecovery({
    examData: exam,
    serverResponses: server,
    serverVersion: 4,
    localRecord: { version: 4, userResponses: local }
  });
  assert.equal(sameVersion.conflict, false);
  assert.equal(sameVersion.usedLocal, true);
  assert.equal(sameVersion.responses.Physics[0].selectedOption, 2);

  const staleVersion = reconcileOfflineRecovery({
    examData: exam,
    serverResponses: server,
    serverVersion: 5,
    localRecord: { version: 4, userResponses: local }
  });
  assert.equal(staleVersion.conflict, true);
  assert.equal(staleVersion.usedLocal, false);
  assert.deepEqual(staleVersion.responses, server);
});

test('offline storage failure is returned to the UI instead of being reported as saved', () => {
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    setItem() { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
    getItem() { return null; },
    removeItem() {}
  };
  try {
    const result = saveOfflineRecoveryRecord({
      student: { id: 'STU-1', docId: 'auth-1' },
      examId: 'exam-1',
      userUuid: 'auth-1',
      examData: exam,
      userResponses: createInitialResponses(exam),
      activeSubject: 'Physics',
      currentIndices: { Physics: 0 },
      version: 1,
      endTime: Date.now() + 1000
    });
    assert.equal(result.success, false);
    assert.equal(result.error.name, 'QuotaExceededError');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});
