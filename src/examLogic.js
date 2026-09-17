export const VALID_RESPONSE_STATUSES = new Set([
  'NOT_VISITED', 'NOT_ANSWERED', 'ANSWERED', 'MARKED', 'ANSWERED_MARKED'
]);

export const SERVER_GRACE_PERIOD_SECONDS = 180;
export const RECOVERY_SCHEMA_VERSION = 1;

const pendingSubmissionSyncs = new Set();

function localStore(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function storageGet(storage, key) {
  try { return localStore(storage)?.getItem(key) ?? null; } catch { return null; }
}

function storageSet(storage, key, value) {
  try {
    const target = localStore(storage);
    if (!target) return false;
    target.setItem(key, value);
    return true;
  } catch { return false; }
}

function storageRemove(storage, key) {
  try { localStore(storage)?.removeItem(key); } catch {}
}

function studentStorageKey(student, userUuid) {
  const value = userUuid || student?.docId || student?.id;
  return value ? String(value) : '';
}

export function formatRecoveryStorageKey(studentKey, examId) {
  return `cbt_recovery_v${RECOVERY_SCHEMA_VERSION}_${studentKey}_${examId}`;
}

export function formatPendingSubmissionStorageKey(studentKey, examId) {
  return `cbt_pending_submission_v${RECOVERY_SCHEMA_VERSION}_${studentKey}_${examId}`;
}

export function formatPendingSubmissionPointerKey(studentKey) {
  return `cbt_pending_submission_id_v${RECOVERY_SCHEMA_VERSION}_${studentKey}`;
}

export function formatPendingTerminationStorageKey(studentKey) {
  return `cbt_pending_termination_v${RECOVERY_SCHEMA_VERSION}_${studentKey}`;
}

function isValidPendingSubmission(record, student, examId) {
  return Boolean(record
    && record.schemaVersion === RECOVERY_SCHEMA_VERSION
    && String(record.examId || '') === String(examId || '')
    && Array.isArray(record.responses)
    && sessionBelongsToStudent(record, student));
}

export function savePendingSubmissionRecord({ student, examId, userUuid, responses, storage }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey || !examId || !Array.isArray(responses)) {
    return { success: false, error: new Error('Student, exam, and responses are required.') };
  }
  const record = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    examId: String(examId),
    studentId: String(student?.id || studentKey),
    userUuid: String(userUuid || student?.docId || ''),
    responses,
    timestamp: Date.now()
  };
  const recordKey = formatPendingSubmissionStorageKey(studentKey, examId);
  const pointerKey = formatPendingSubmissionPointerKey(studentKey);
  const previousRecord = storageGet(storage, recordKey);
  const previousPointer = storageGet(storage, pointerKey);
  if (!storageSet(storage, recordKey, JSON.stringify(record))
      || !storageSet(storage, pointerKey, String(examId))) {
    if (previousRecord === null) storageRemove(storage, recordKey);
    else storageSet(storage, recordKey, previousRecord);
    if (previousPointer === null) storageRemove(storage, pointerKey);
    else storageSet(storage, pointerKey, previousPointer);
    return { success: false, error: new Error('Browser storage is unavailable.') };
  }
  return { success: true, error: null, record };
}

export function readPendingSubmissionRecord({ student, examId, userUuid, storage }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey) return null;
  const pointerKey = formatPendingSubmissionPointerKey(studentKey);
  const scopedExamId = String(examId || storageGet(storage, pointerKey) || '');
  if (scopedExamId) {
    const recordKey = formatPendingSubmissionStorageKey(studentKey, scopedExamId);
    const raw = storageGet(storage, recordKey);
    if (raw) {
      try {
        const record = JSON.parse(raw);
        if (isValidPendingSubmission(record, student, scopedExamId)) return record;
      } catch {}
      storageRemove(storage, recordKey);
      if (storageGet(storage, pointerKey) === scopedExamId) storageRemove(storage, pointerKey);
      return null;
    }
    if (!examId && storageGet(storage, pointerKey) === scopedExamId) storageRemove(storage, pointerKey);
  }

  // Adopt the old exam-only key only after proving account ownership.
  const legacyExamId = String(examId || storageGet(storage, 'cbt_pending_submission_id') || '');
  if (!legacyExamId) return null;
  const legacyKey = `cbt_pending_submission_${legacyExamId}`;
  const legacyRaw = storageGet(storage, legacyKey);
  if (!legacyRaw) return null;
  try {
    const legacy = JSON.parse(legacyRaw);
    if (!isValidPendingSubmission(legacy, student, legacyExamId)) return null;
    const migrated = savePendingSubmissionRecord({ student, examId: legacyExamId, userUuid, responses: legacy.responses, storage });
    if (migrated.success) {
      storageRemove(storage, legacyKey);
      if (storageGet(storage, 'cbt_pending_submission_id') === legacyExamId) {
        storageRemove(storage, 'cbt_pending_submission_id');
      }
      return migrated.record;
    }
    return legacy;
  } catch { return null; }
}

export function clearPendingSubmissionRecord({ student, examId, userUuid, storage }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey || !examId) return;
  const normalizedExamId = String(examId);
  storageRemove(storage, formatPendingSubmissionStorageKey(studentKey, normalizedExamId));
  const pointerKey = formatPendingSubmissionPointerKey(studentKey);
  if (storageGet(storage, pointerKey) === normalizedExamId) storageRemove(storage, pointerKey);

  const legacyKey = `cbt_pending_submission_${normalizedExamId}`;
  const legacyRaw = storageGet(storage, legacyKey);
  try {
    if (legacyRaw && isValidPendingSubmission(JSON.parse(legacyRaw), student, normalizedExamId)) {
      storageRemove(storage, legacyKey);
      if (storageGet(storage, 'cbt_pending_submission_id') === normalizedExamId) {
        storageRemove(storage, 'cbt_pending_submission_id');
      }
    }
  } catch {}
}

export function beginPendingSubmissionSync({ student, examId, userUuid }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey || !examId) return false;
  const key = `${studentKey}:${examId}`;
  if (pendingSubmissionSyncs.has(key)) return false;
  pendingSubmissionSyncs.add(key);
  return true;
}

export function finishPendingSubmissionSync({ student, examId, userUuid }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (studentKey && examId) pendingSubmissionSyncs.delete(`${studentKey}:${examId}`);
}

export function savePendingTerminationRecord({ student, examId, userUuid, storage }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey || !examId) return false;
  return storageSet(storage, formatPendingTerminationStorageKey(studentKey), JSON.stringify({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    examId: String(examId),
    studentId: String(student?.id || studentKey),
    userUuid: String(userUuid || student?.docId || ''),
    timestamp: Date.now()
  }));
}

export function readPendingTerminationRecord({ student, userUuid, storage }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey) return null;
  const key = formatPendingTerminationStorageKey(studentKey);
  const raw = storageGet(storage, key);
  if (raw) {
    try {
      const record = JSON.parse(raw);
      if (record?.schemaVersion === RECOVERY_SCHEMA_VERSION && record?.examId
          && sessionBelongsToStudent(record, student)) return record;
    } catch {}
    storageRemove(storage, key);
    return null;
  }
  const legacyRaw = storageGet(storage, 'cbt_pending_termination');
  if (!legacyRaw) return null;
  try {
    const legacy = JSON.parse(legacyRaw);
    if (!legacy?.examId || !sessionBelongsToStudent(legacy, student)) return null;
    if (savePendingTerminationRecord({ student, examId: legacy.examId, userUuid, storage })) {
      storageRemove(storage, 'cbt_pending_termination');
    }
    return legacy;
  } catch { return null; }
}

export function clearPendingTerminationRecord({ student, userUuid, storage }) {
  const studentKey = studentStorageKey(student, userUuid);
  if (!studentKey) return;
  storageRemove(storage, formatPendingTerminationStorageKey(studentKey));
  const legacyRaw = storageGet(storage, 'cbt_pending_termination');
  try {
    if (legacyRaw && sessionBelongsToStudent(JSON.parse(legacyRaw), student)) {
      storageRemove(storage, 'cbt_pending_termination');
    }
  } catch {}
}

export function createInitialResponses(examData) {
  const initial = {};
  const subjects = Array.isArray(examData?.subjects) ? examData.subjects : [];
  subjects.forEach((subject) => {
    const questions = Array.isArray(examData?.questions?.[subject]) ? examData.questions[subject] : [];
    initial[subject] = questions.map(() => ({ selectedOption: null, status: 'NOT_VISITED' }));
  });
  const firstSubject = subjects[0];
  if (firstSubject && initial[firstSubject]?.[0]) {
    initial[firstSubject][0] = { selectedOption: null, status: 'NOT_ANSWERED' };
  }
  return initial;
}

export function buildSubmissionResponses(examData, userResponses) {
  const subjects = Array.isArray(examData?.subjects) ? examData.subjects : [];
  return subjects.flatMap((subject) => {
    const questions = Array.isArray(examData?.questions?.[subject]) ? examData.questions[subject] : [];
    return questions
      .map((question, index) => {
        if (typeof question?.id !== 'string' || question.id.length === 0) return null;
        const response = userResponses?.[subject]?.[index] || {};
        const option = response.selectedOption !== undefined ? response.selectedOption : null;
        return {
          question_id: question.id,
          selected_option: option,
          status: VALID_RESPONSE_STATUSES.has(response.status) ? response.status : 'NOT_VISITED'
        };
      })
      .filter(Boolean);
  });
}

export function sessionBelongsToStudent(session, student) {
  if (!session || !student) return false;
  const studentKeys = [student.docId, student.id].filter(Boolean).map(String);
  const sessionStudentId = String(session.studentId || session.student_id || session.userUuid || '');
  return studentKeys.includes(sessionStudentId);
}

export function remainingSecondsUntil(endTime, now = Date.now()) {
  const numericEndTime = Number(endTime);
  if (!Number.isFinite(numericEndTime)) return 0;
  return Math.max(0, Math.ceil((numericEndTime - now) / 1000));
}

/**
 * Persists an offline recovery snapshot with strict schema versioning and ownership.
 */
export function saveOfflineRecoveryRecord({
  student,
  examId,
  examTitle,
  userUuid,
  examData,
  userResponses,
  activeSubject,
  currentIndices,
  version,
  endTime
}) {
  if (!student || !examId) {
    return { success: false, error: new Error('Student and exam are required for recovery storage.') };
  }
  const studentKey = userUuid || student.docId || student.id;
  const key = formatRecoveryStorageKey(studentKey, examId);

  try {
    const record = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      userUuid: String(userUuid || student.docId || ''),
      studentId: String(student.id || student.docId || ''),
      examId: String(examId),
      sessionId: `${studentKey}_${examId}`,
      savedAt: Date.now(),
      version: Number(version || 1),
      endTime: Number(endTime || 0),
      activeSubject: String(activeSubject || ''),
      currentIndices: currentIndices && typeof currentIndices === 'object' ? currentIndices : {},
      userResponses: userResponses && typeof userResponses === 'object' ? userResponses : {}
    };

    localStorage.setItem(key, JSON.stringify(record));
    // Also maintain backwards-compatible mirror key for existing tests/checks
    localStorage.setItem('cbt_active_exam_session', JSON.stringify({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      examId,
      userUuid: String(userUuid || student.docId || ''),
      studentId: studentKey,
      activeExam: {
        id: examId,
        ...(typeof examTitle === 'string' && examTitle.trim()
          ? { title: examTitle.trim() }
          : {})
      },
      examData,
      userResponses,
      activeSubject,
      currentIndices,
      endTime,
      savedAt: record.savedAt,
      version: record.version
    }));
    return { success: true, error: null };
  } catch (err) {
    console.warn('Storage quota exceeded or storage unavailable for recovery record:', err);
    return { success: false, error: err };
  }
}

/**
 * Reads and validates an offline recovery snapshot.
 * Rejects corrupt, unsupported, or foreign-account records.
 */
export function readOfflineRecoveryRecord({ student, examId, userUuid, storage }) {
  if (!student || !examId) return null;
  const studentKey = userUuid || student.docId || student.id;
  const key = formatRecoveryStorageKey(studentKey, examId);

  let raw = storageGet(storage, key);
  if (!raw) {
    // Check fallback mirror key
    raw = storageGet(storage, 'cbt_active_exam_session');
  }
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      storageRemove(storage, key);
      return null;
    }

    // Verify ownership
    const studentKeys = [student.docId, student.id, userUuid].filter(Boolean).map(String);
    const recordStudentKey = String(parsed.studentId || parsed.userUuid || '');
    if (!studentKeys.includes(recordStudentKey)) {
      console.warn('Discarding recovery record belonging to another student.');
      storageRemove(storage, key);
      return null;
    }

    // Verify exam identity
    const recordExamId = String(parsed.examId || parsed.activeExam?.id || '');
    if (recordExamId !== String(examId)) {
      return null;
    }

    // Recovery formats are strict: ambiguous legacy shapes are not restored.
    if (parsed.schemaVersion !== RECOVERY_SCHEMA_VERSION) {
      console.warn('Discarding unsupported recovery schema version:', parsed.schemaVersion);
      storageRemove(storage, key);
      return null;
    }

    return parsed;
  } catch (err) {
    console.warn('Discarding corrupt recovery record:', err);
    storageRemove(storage, key);
    return null;
  }
}

/**
 * Clears recovery records for an exam attempt upon confirmed completion or cancellation.
 */
export function clearOfflineRecoveryRecord({ student, examId, userUuid, storage }) {
  if (student && examId) {
    const studentKey = userUuid || student.docId || student.id;
    storageRemove(storage, formatRecoveryStorageKey(studentKey, examId));
  }
  const mirrorRaw = storageGet(storage, 'cbt_active_exam_session');
  try {
    const mirror = mirrorRaw ? JSON.parse(mirrorRaw) : null;
    const mirrorExamId = String(mirror?.examId || mirror?.activeExam?.id || '');
    if (mirror && String(examId || '') === mirrorExamId && sessionBelongsToStudent(mirror, student)) {
      storageRemove(storage, 'cbt_active_exam_session');
    }
  } catch {}
  clearPendingSubmissionRecord({ student, examId, userUuid, storage });
}

/**
 * Merges responses into the server-owned question paper.
 * Preserves numeric zero and valid statuses; discards unknown question IDs.
 */
export function mergeOfflineResponses(serverExamData, serverResponses, localResponses) {
  if (!serverExamData || !serverExamData.questions) {
    return serverResponses || {};
  }

  const merged = {};
  const subjects = Array.isArray(serverExamData.subjects) ? serverExamData.subjects : Object.keys(serverExamData.questions);

  subjects.forEach((subject) => {
    const questions = Array.isArray(serverExamData.questions[subject]) ? serverExamData.questions[subject] : [];
    const serverSubj = serverResponses?.[subject] || [];
    const localSubj = localResponses?.[subject] || [];

    merged[subject] = questions.map((q, idx) => {
      const serverResp = serverSubj[idx];
      const localResp = localSubj[idx];

      // Prefer local response if it has an answer or visited status
      if (localResp && typeof localResp === 'object') {
        const option = localResp.selectedOption;
        const hasLocalOption = option !== null && option !== undefined && option !== '';
        const validStatus = VALID_RESPONSE_STATUSES.has(localResp.status) ? localResp.status : 'NOT_VISITED';

        if (hasLocalOption || validStatus !== 'NOT_VISITED') {
          return {
            selectedOption: hasLocalOption ? option : (serverResp?.selectedOption ?? null),
            status: validStatus
          };
        }
      }

      return serverResp && typeof serverResp === 'object'
        ? {
            selectedOption: serverResp.selectedOption ?? null,
            status: VALID_RESPONSE_STATUSES.has(serverResp.status) ? serverResp.status : 'NOT_VISITED'
          }
        : { selectedOption: null, status: idx === 0 && subject === subjects[0] ? 'NOT_ANSWERED' : 'NOT_VISITED' };
    });
  });

  return merged;
}

/**
 * Reconciles a recovery record against an authoritative server session.
 * Local responses may overlay the server only when both share the exact same
 * base version. A stale/future record never silently overwrites newer confirmed
 * progress.
 */
export function reconcileOfflineRecovery({
  examData,
  serverResponses,
  serverVersion,
  localRecord
}) {
  const authoritative = serverResponses && typeof serverResponses === 'object' ? serverResponses : {};
  if (!localRecord || typeof localRecord !== 'object') {
    return { responses: authoritative, conflict: false, usedLocal: false };
  }

  const localVersion = Number(localRecord.version);
  const authoritativeVersion = Number(serverVersion);
  if (!Number.isInteger(localVersion) || localVersion < 1
      || !Number.isInteger(authoritativeVersion) || authoritativeVersion < 1
      || localVersion !== authoritativeVersion) {
    return {
      responses: authoritative,
      conflict: true,
      usedLocal: false,
      localVersion: Number.isFinite(localVersion) ? localVersion : null,
      serverVersion: Number.isFinite(authoritativeVersion) ? authoritativeVersion : null
    };
  }

  return {
    responses: mergeOfflineResponses(examData, authoritative, localRecord.userResponses),
    conflict: false,
    usedLocal: true,
    localVersion,
    serverVersion: authoritativeVersion
  };
}
