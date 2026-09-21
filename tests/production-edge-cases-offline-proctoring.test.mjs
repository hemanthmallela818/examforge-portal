import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionBelongsToStudent,
  savePendingSubmissionRecord,
  readPendingSubmissionRecord,
  clearPendingSubmissionRecord,
  beginPendingSubmissionSync,
  finishPendingSubmissionSync,
  savePendingTerminationRecord,
  readPendingTerminationRecord,
  clearPendingTerminationRecord,
  reconcileOfflineRecovery,
  RECOVERY_SCHEMA_VERSION
} from '../src/examLogic.js';

class MockStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

test('session ownership: strictly verifies candidate identity against cached session', () => {
  const alice = { id: 'STU-001', docId: 'uuid-alice', name: 'Alice' };
  const bob = { id: 'STU-002', docId: 'uuid-bob', name: 'Bob' };

  const validAliceSession = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    studentId: 'STU-001',
    userUuid: 'uuid-alice',
    examId: 'exam-101'
  };

  assert.equal(sessionBelongsToStudent(validAliceSession, alice), true);
  assert.equal(sessionBelongsToStudent(validAliceSession, bob), false);
  assert.equal(sessionBelongsToStudent(validAliceSession, null), false);
  assert.equal(sessionBelongsToStudent(null, alice), false);

  // Mismatched studentId
  assert.equal(sessionBelongsToStudent({ studentId: 'STU-002' }, alice), false);

  // Mismatched userUuid
  assert.equal(sessionBelongsToStudent({ studentId: 'uuid-bob' }, alice), false);
});

test('shared computer isolation: students never access or overwrite each other\'s offline pending submissions', () => {
  const storage = new MockStorage();
  const alice = { id: 'STU-001', docId: 'uuid-alice' };
  const bob = { id: 'STU-002', docId: 'uuid-bob' };
  const examId = 'exam-101';

  // 1. Alice saves pending submission
  const pendingAlice = savePendingSubmissionRecord({
    student: alice,
    examId,
    userUuid: alice.docId,
    responses: [{ questionId: 'q1', answer: 'A' }],
    storage
  });
  assert.equal(pendingAlice.success, true);

  // 2. Bob signs in on the same browser; checks for pending submissions
  const bobPending = readPendingSubmissionRecord({
    student: bob,
    examId,
    userUuid: bob.docId,
    storage
  });
  assert.equal(bobPending, null, 'Bob must NOT be able to read Alice\'s pending submission');

  // 3. Bob saves his own pending submission for the same exam
  const pendingBob = savePendingSubmissionRecord({
    student: bob,
    examId,
    userUuid: bob.docId,
    responses: [{ questionId: 'q1', answer: 'B' }],
    storage
  });
  assert.equal(pendingBob.success, true);

  // 4. Bob clears his pending submission after successful submit
  clearPendingSubmissionRecord({
    student: bob,
    examId,
    userUuid: bob.docId,
    storage
  });

  // 5. Alice signs back in: her pending submission remains intact!
  const alicePendingRestored = readPendingSubmissionRecord({
    student: alice,
    examId,
    userUuid: alice.docId,
    storage
  });
  assert.ok(alicePendingRestored);
  assert.equal(alicePendingRestored.responses[0].answer, 'A');
  assert.equal(alicePendingRestored.studentId, 'STU-001');
});

test('pending submission sync: enforces single-flight execution per student and exam', () => {
  const alice = { id: 'STU-001', docId: 'uuid-alice' };
  const bob = { id: 'STU-002', docId: 'uuid-bob' };
  const exam1 = 'exam-101';
  const exam2 = 'exam-102';

  // First sync for Alice exam1 succeeds
  assert.equal(beginPendingSubmissionSync({ student: alice, examId: exam1, userUuid: alice.docId }), true);

  // Concurrent second sync for Alice exam1 is blocked (single flight)
  assert.equal(beginPendingSubmissionSync({ student: alice, examId: exam1, userUuid: alice.docId }), false);

  // Concurrent sync for Alice exam2 is allowed (different exam)
  assert.equal(beginPendingSubmissionSync({ student: alice, examId: exam2, userUuid: alice.docId }), true);

  // Concurrent sync for Bob exam1 is allowed (different student)
  assert.equal(beginPendingSubmissionSync({ student: bob, examId: exam1, userUuid: bob.docId }), true);

  // Finishing Alice exam1 unlocks subsequent attempts
  finishPendingSubmissionSync({ student: alice, examId: exam1, userUuid: alice.docId });
  assert.equal(beginPendingSubmissionSync({ student: alice, examId: exam1, userUuid: alice.docId }), true);

  // Clean up
  finishPendingSubmissionSync({ student: alice, examId: exam1, userUuid: alice.docId });
  finishPendingSubmissionSync({ student: alice, examId: exam2, userUuid: alice.docId });
  finishPendingSubmissionSync({ student: bob, examId: exam1, userUuid: bob.docId });
});

test('proctoring violation: offline termination is persisted and isolated per candidate', () => {
  const storage = new MockStorage();
  const student1 = { id: 'STU-100', docId: 'uuid-100' };
  const student2 = { id: 'STU-200', docId: 'uuid-200' };

  // Student 1 triggers third security violation while offline
  const terminationSaved = savePendingTerminationRecord({
    student: student1,
    examId: 'exam-proctor',
    userUuid: student1.docId,
    storage
  });
  assert.equal(terminationSaved, true);

  // Student 2 cannot read or clear student 1's pending termination
  const s2Read = readPendingTerminationRecord({
    student: student2,
    userUuid: student2.docId,
    storage
  });
  assert.equal(s2Read, null);

  clearPendingTerminationRecord({
    student: student2,
    userUuid: student2.docId,
    storage
  });

  // Student 1's termination record remains active for immediate dispatch upon reconnect
  const s1Read = readPendingTerminationRecord({
    student: student1,
    userUuid: student1.docId,
    storage
  });
  assert.ok(s1Read);
  assert.equal(s1Read.examId, 'exam-proctor');
  assert.equal(s1Read.studentId, 'STU-100');

  // Student 1 clears their own record after successful sync
  clearPendingTerminationRecord({
    student: student1,
    userUuid: student1.docId,
    storage
  });
  assert.equal(readPendingTerminationRecord({ student: student1, userUuid: student1.docId, storage }), null);
});

test('reconciliation: non-destructive response merge preserves newer offline progress', () => {
  const baseExam = {
    subjects: ['Physics'],
    questions: {
      Physics: [
        { id: 'q1', type: 'MCQ', text: 'Q1', options: ['A', 'B', 'C', 'D'] },
        { id: 'q2', type: 'MCQ', text: 'Q2', options: ['A', 'B', 'C', 'D'] }
      ]
    }
  };

  const serverConfirmedResponses = {
    Physics: [
      { selectedOption: 0, status: 'ANSWERED' },
      { selectedOption: null, status: 'NOT_VISITED' }
    ]
  };

  const offlineLocalRecord = {
    version: 1,
    userResponses: {
      Physics: [
        { selectedOption: 0, status: 'ANSWERED' },
        { selectedOption: 2, status: 'ANSWERED' } // Student answered Q2 while offline
      ]
    }
  };

  // Case 1: Matching versions -> local responses merged onto server responses
  const reconciled = reconcileOfflineRecovery({
    examData: baseExam,
    serverResponses: serverConfirmedResponses,
    serverVersion: 1,
    localRecord: offlineLocalRecord
  });

  assert.equal(reconciled.conflict, false);
  assert.equal(reconciled.usedLocal, true);
  assert.equal(reconciled.responses.Physics[0].selectedOption, 0);
  assert.equal(reconciled.responses.Physics[1].selectedOption, 2, 'Locally answered Q2 must be preserved during reconciliation');
  assert.equal(reconciled.responses.Physics[1].status, 'ANSWERED');

  // Case 2: Version conflict (server version 2 > local version 1) -> fails closed to authoritative server responses
  const conflicted = reconcileOfflineRecovery({
    examData: baseExam,
    serverResponses: serverConfirmedResponses,
    serverVersion: 2,
    localRecord: offlineLocalRecord
  });

  assert.equal(conflicted.conflict, true);
  assert.equal(conflicted.usedLocal, false);
  assert.equal(conflicted.responses.Physics[1].selectedOption, null, 'Conflicting offline responses must not overwrite newer server progress');
});
