/** @import { QuestionBankItem, UntrustedInput } from './types' */

/**
 * @param {unknown} value
 * @returns {'MCQ' | 'NUMERICAL'}
 */
const normalizeType = value => ['NAT', 'NUMERICAL'].includes(String(value || '').toUpperCase()) ? 'NUMERICAL' : 'MCQ';

/**
 * @param {UntrustedInput} row Raw `questions` table row.
 * @returns {QuestionBankItem}
 */
export const normalizeQuestionBankRow = row => ({
  docId: row.id,
  id: row.id,
  subject: row.subject,
  type: normalizeType(row.type),
  questionNumber: Number(row.question_number),
  text: row.question_text || '',
  options: row.options,
  correctAnswer: row.correct_answer,
  questionImageUrl: row.question_image_url,
  optionImageUrls: row.option_image_urls,
  hasImageOrDiagram: row.has_image_or_diagram,
  createdAt: row.created_at
});

/**
 * @param {UntrustedInput} data RPC payload `{ requested_count, rows }`.
 * @param {string[]} expectedIds Selected question IDs, in order.
 * @returns {QuestionBankItem[]}
 */
export const parseSelectedQuestionsResponse = (data, expectedIds) => {
  if (!Array.isArray(expectedIds) || expectedIds.length === 0) throw new TypeError('At least one selected question is required.');
  if (new Set(expectedIds).size !== expectedIds.length) throw new Error('Selected question IDs must be unique.');
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.rows)) {
    throw new TypeError('The server returned an invalid selected-question response.');
  }
  if (Number(data.requested_count) !== expectedIds.length || data.rows.length !== expectedIds.length) {
    throw new Error('One or more selected questions no longer exist. Refresh the Question Bank and review the selection.');
  }
  const returnedIds = data.rows.map((/** @type {UntrustedInput} */ row) => row?.id);
  if (returnedIds.some((/** @type {unknown} */ id, /** @type {number} */ index) => id !== expectedIds[index]) || new Set(returnedIds).size !== returnedIds.length) {
    throw new Error('The server returned a different question selection than requested.');
  }
  return data.rows.map(normalizeQuestionBankRow);
};
