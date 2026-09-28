import { canonicalQuestionText, questionIdentityKey, resolveAllowedSubjects, subjectRequirementMessage } from './importLogic.js';
import { isValidAuthorAnswer, normalizeQuestionType, questionTypeInfo, validateQuestionDetails } from './questionTypes.js';

/** @import { PreparedQuestion, QuestionDetails, QuestionTextLike, UntrustedInput } from './types' */

/**
 * Exactly `length` entries from `value` (missing/nullish entries become `fallback`).
 * @param {unknown} value
 * @param {number} length
 * @param {unknown} [fallback]
 * @returns {unknown[]}
 */
const fixedArray = (value, length, fallback = null) => Array.from(
  { length },
  (_, index) => Array.isArray(value) ? (value[index] ?? fallback) : fallback
);

/**
 * Trimmed details (match lists, paragraph) or null when there are none.
 * Structurally invalid values are passed through for validation to report.
 * @param {UntrustedInput} value
 * @returns {QuestionDetails | null}
 */
export const normalizeDetails = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value ? value : null;
  /** @type {UntrustedInput} */
  const details = {};
  if (value.matchLists !== undefined) {
    const lists = value.matchLists;
    details.matchLists = lists && typeof lists === 'object' && !Array.isArray(lists)
      ? {
          left: Array.isArray(lists.left) ? lists.left.map((/** @type {unknown} */ item) => String(item ?? '').trim()) : lists.left,
          right: Array.isArray(lists.right) ? lists.right.map((/** @type {unknown} */ item) => String(item ?? '').trim()) : lists.right
        }
      : lists;
  }
  if (value.passage !== undefined) {
    const passage = value.passage;
    details.passage = passage && typeof passage === 'object' && !Array.isArray(passage)
      ? { key: passage.key, text: typeof passage.text === 'string' ? passage.text.trim() : passage.text }
      : passage;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'matchLists' && key !== 'passage') details[key] = value[key];
  }
  return Object.keys(details).length ? details : null;
};

/**
 * Normalises a Question Editor draft and lists every problem that blocks saving.
 * @param {UntrustedInput} draft Editor state (camelCase or snake_case fields).
 * @param {QuestionTextLike[]} [existingQuestions]
 * @param {{ allowedSubjects?: unknown }} [settings]
 * @returns {{ question: PreparedQuestion, errors: string[] }}
 */
export const prepareQuestionDraft = (draft, existingQuestions = [], settings = {}) => {
  const allowedSubjects = resolveAllowedSubjects(settings.allowedSubjects);
  // A missing type is an error here, not MCQ.
  const type = String(draft?.type ?? '').trim() ? normalizeQuestionType(draft?.type) : '';
  const typeInfo = type ? questionTypeInfo(type) : null;
  const optionBased = typeInfo?.optionBased === true;
  const text = String(draft?.text ?? draft?.question_text ?? '').trim();
  const subject = String(draft?.subject || '').trim();
  const questionImageUrl = draft?.questionImageUrl || draft?.question_image_url || null;
  const sourceOptionImages = draft?.optionImageUrls || draft?.option_image_urls;
  const optionImageUrls = optionBased ? fixedArray(sourceOptionImages, 4) : [];
  const options = optionBased
    ? fixedArray(draft?.options, 4, '').map(option => String(option || '').trim())
    : [];
  const details = normalizeDetails(draft?.details);
  const correctAnswer = String(draft?.correctAnswer ?? draft?.correct_answer ?? '').trim();
  const hasImageOrDiagram = Boolean(draft?.hasImageOrDiagram ?? draft?.has_image_or_diagram) || Boolean(questionImageUrl);
  /** @type {string[]} */
  const errors = [];

  if (!allowedSubjects.includes(subject)) errors.push(subjectRequirementMessage(allowedSubjects));
  if (!typeInfo) errors.push('Choose a supported question type.');
  if (!text && !questionImageUrl) errors.push('Enter a question prompt or upload a question image.');
  if (text.length > 10000) errors.push('Question text must not exceed 10,000 characters.');
  if (hasImageOrDiagram && !questionImageUrl) errors.push('This question is marked as requiring an image or diagram. Upload it before saving.');

  if (optionBased) {
    const optionKeys = new Set();
    options.forEach((option, index) => {
      const image = optionImageUrls[index];
      if (!option && !image) errors.push(`Provide text or an image for Option ${String.fromCharCode(65 + index)}.`);
      if (option.length > 5000) errors.push(`Option ${String.fromCharCode(65 + index)} must not exceed 5,000 characters.`);
      const key = image ? `img:${image}` : `text:${canonicalQuestionText(option)}`;
      if ((option || image) && optionKeys.has(key)) errors.push(`Option ${String.fromCharCode(65 + index)} duplicates another option.`);
      optionKeys.add(key);
    });
    if (!isValidAuthorAnswer(type, correctAnswer)) {
      errors.push(type === 'MULTIPLE_CORRECT'
        ? 'Choose at least one correct option.'
        : 'Select a valid correct option from A to D.');
    }
  } else if (type === 'NUMERICAL') {
    if (!isValidAuthorAnswer(type, correctAnswer)) {
      errors.push('Enter a valid numerical answer of at most 100 characters.');
    }
  } else if (type === 'INTEGER') {
    if (!isValidAuthorAnswer(type, correctAnswer)) errors.push('Enter a whole-number answer of at most 100 characters.');
  }
  const detailsError = typeInfo ? validateQuestionDetails(type, details) : null;
  if (detailsError) errors.push(`${detailsError}.`);

  const key = questionIdentityKey(text, details);
  if (canonicalQuestionText(text) && existingQuestions.some(question => {
    if ((question.docId || question.id) === (draft.docId || draft.id)) return false;
    return questionIdentityKey(question.text ?? question.question_text, normalizeDetails(question.details)) === key;
  })) errors.push('A matching question already exists in the Question Bank.');

  return {
    question: {
      ...draft,
      subject,
      type,
      text,
      options,
      correctAnswer,
      questionImageUrl,
      optionImageUrls,
      hasImageOrDiagram,
      details
    },
    errors: [...new Set(errors)]
  };
};
