/** @import { ExamListItem, UntrustedInput } from './types' */

/**
 * @param {UntrustedInput} row Raw exam summary row from the server.
 * @returns {ExamListItem}
 */
export const normalizeExamListRow = row => {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || typeof row.title !== 'string') {
    throw new TypeError('The server returned an invalid examination summary.');
  }
  const duration = Number(row.duration);
  const totalQuestions = Number(row.total_questions);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isInteger(totalQuestions) || totalQuestions < 0) {
    throw new Error('The server returned invalid examination counts.');
  }
  if (!Array.isArray(row.subjects) || row.subjects.some((/** @type {unknown} */ subject) => typeof subject !== 'string')) {
    throw new Error('The server returned invalid examination subjects.');
  }
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    class: row.class,
    section: row.section,
    created_at: row.created_at,
    questionsData: { duration, totalQuestions, subjects: row.subjects }
  };
};
