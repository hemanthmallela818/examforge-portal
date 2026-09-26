// Pure helpers shared by the student exam session hooks and the App shell.
import { safeStorageGet, safeStorageSet, safeStorageRemove, safeStorageJson } from '../../browserStorage';
import { APP_ERROR, classifyAppError } from '../../appErrors';
import { sessionBelongsToStudent, RECOVERY_SCHEMA_VERSION } from '../../examLogic';

/**
 * The signed-in candidate kept in App state and sessionStorage. `id` is the
 * public student ID; `docId` is the Supabase Auth UUID.
 * @typedef {{
 *   id: string,
 *   docId: string,
 *   name: string,
 *   class?: string | null,
 *   section?: string | null,
 *   sessionToken?: string | null,
 *   [field: string]: unknown
 * }} CurrentStudent
 */

/**
 * Why an attempt was ended early: the student left the exam (another tab,
 * window or app, or fullscreen) once too often, or it was ended another way.
 * @typedef {import('./useExamLockdown').ExamLeaveReason | 'ended'} TerminationReason
 */

/**
 * An exam as listed on the student dashboard and held as the active exam.
 * @typedef {{
 *   id: string,
 *   title?: string,
 *   questionsData?: import('../../types').ExamPaper,
 *   questions_data?: import('../../types').ExamPaper,
 *   [field: string]: unknown
 * }} ActiveExam
 */

/**
 * Scorecard rendered by `Result` (server `submit_exam` payload or a mapped
 * `student_results` row).
 * @typedef {import('../../types').UntrustedInput} Scorecard
 */

/** @type {import('../../types').ExamPaper} */
export const emptyExam = { subjects: [], questions: {} };

/** @returns {import('../../types').ActiveExamSessionMirror | null} */
export const readStoredSessionMirror = () => {
  try {
    const raw = safeStorageGet('localStorage', 'cbt_active_exam_session');
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session?.schemaVersion === RECOVERY_SCHEMA_VERSION && session?.activeExam && session?.endTime) return session;
  } catch {}
  return null;
};

/** @param {import('../../types').StudentIdentity | null | undefined} student */
export const readStoredActiveSession = (student) => {
  const session = readStoredSessionMirror();
  return /** @type {number} */ (session?.endTime) > Date.now() && sessionBelongsToStudent(session, student) ? session : null;
};

/** @returns {CurrentStudent | null} */
export const readStoredStudent = () => {
  const student = safeStorageJson('sessionStorage', 'currentStudent');
  if (!student) {
    safeStorageRemove('sessionStorage', 'currentStudent');
    safeStorageSet('sessionStorage', 'examState', 'AUTH');
  }
  return student;
};

// Error handling branches on stable codes (src/appErrors.js, docs/ERROR_CODES.md),
// not on message wording.
/** @param {unknown} error */
export const isStudentSessionReplaced = (error) => classifyAppError(error) === APP_ERROR.SESSION_REPLACED;

/** @type {Readonly<Record<string, string>>} */
const EXAM_ERROR_MESSAGES = Object.freeze({
  [APP_ERROR.SESSION_REPLACED]: 'This login was replaced by another device. Your recoverable exam work remains saved; sign in again only if you need to take over.',
  [APP_ERROR.ALREADY_SUBMITTED]: 'This exam has already been submitted.',
  [APP_ERROR.NOT_ASSIGNED]: 'This exam is not assigned to your class or section.',
  [APP_ERROR.EXAM_UNAVAILABLE]: 'This exam is not currently available.',
  [APP_ERROR.TIME_EXPIRED]: 'Your exam time has expired. Your attempt has been finalized.',
  [APP_ERROR.SESSION_NOT_STARTED]: 'Your exam session is no longer valid. Return to the dashboard and contact the invigilator.',
  [APP_ERROR.PROFILE_MISSING]: 'Your student account is not set up correctly. Contact the invigilator.',
  [APP_ERROR.ANSWER_KEY_MISSING]: 'This exam cannot be submitted. Contact the invigilator immediately.'
});

/**
 * @param {unknown} error
 * @param {'start' | 'submit'} action
 * @returns {string}
 */
export function examActionErrorMessage(error, action) {
  const known = EXAM_ERROR_MESSAGES[classifyAppError(error)];
  if (known) return known;

  return action === 'start'
    ? 'Unable to reach the exam server. Check your connection and try again.'
    : 'Unable to submit to the exam server. Check your connection and submit again.';
}

/**
 * Maps a committed `student_results` row to the scorecard shape `Result` renders.
 * @param {import('../../types').UntrustedInput} committedResult
 */
export const committedResultToScorecard = (committedResult) => ({
  totalScore: committedResult.total_score,
  maxScore: committedResult.max_score,
  correct: committedResult.correct,
  incorrect: committedResult.incorrect,
  unattempted: committedResult.unattempted,
  subjectScores: committedResult.subject_scores
});

// Helper to randomly shuffle an array (Fisher-Yates shuffle)
/**
 * @template T
 * @param {readonly T[]} arr
 * @returns {T[]}
 */
export const shuffleArray = (arr) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};
