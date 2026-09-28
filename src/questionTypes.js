/**
 * Question types: the one place the browser learns what each type is, how its
 * answer is written, and how it is marked. The rules mirror the database
 * helpers in supabase/migrations/20260928100000_question_types.sql, which stay
 * authoritative for grading.
 *
 * @import {
 *   ExamMarking, QuestionTypeCode, QuestionTypeInfo, ResolvedMarking, UntrustedInput
 * } from './types'
 */
import { AUTHOR_NUMERICAL_MAX_LENGTH, isValidNumericalAnswer } from './numericalAnswerPolicy.js';

/** @type {readonly QuestionTypeInfo[]} */
export const QUESTION_TYPES = Object.freeze([
  { code: 'MCQ', label: 'Single correct', badge: 'MULTIPLE CHOICE', optionBased: true, valueKind: null },
  { code: 'MULTIPLE_CORRECT', label: 'Multiple correct', badge: 'MULTIPLE CORRECT', optionBased: true, valueKind: null },
  { code: 'INTEGER', label: 'Integer', badge: 'INTEGER TYPE', optionBased: false, valueKind: 'integer' },
  { code: 'NUMERICAL', label: 'Numerical value', badge: 'NUMERICAL VALUE TYPE', optionBased: false, valueKind: 'decimal' },
  { code: 'MATRIX_MATCH', label: 'Matrix match', badge: 'MATRIX MATCH', optionBased: true, valueKind: null },
  { code: 'ASSERTION_REASON', label: 'Assertion–Reason', badge: 'ASSERTION–REASON', optionBased: true, valueKind: null }
]);

/** The standard NTA Assertion–Reason options, in answer order A–D. */
export const ASSERTION_REASON_OPTIONS = Object.freeze([
  'Both (A) and (R) are true and (R) is the correct explanation of (A).',
  'Both (A) and (R) are true but (R) is not the correct explanation of (A).',
  '(A) is true but (R) is false.',
  '(A) is false but (R) is true.'
]);
export const ASSERTION_REASON_TEMPLATE = 'Assertion (A): \n\nReason (R): ';

export const MATCH_LEFT_LABELS = Object.freeze(['P', 'Q', 'R', 'S', 'T', 'U']);
export const MATCH_RIGHT_LABELS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Upper-cases a type and maps the legacy NAT alias to NUMERICAL. An empty type
 * is MCQ (as in the database); an unknown type is returned as-is, never
 * silently turned into MCQ.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeQuestionType(value) {
  const type = String(value ?? '').trim().toUpperCase();
  if (!type) return 'MCQ';
  return type === 'NAT' ? 'NUMERICAL' : type;
}

/**
 * @param {unknown} type
 * @returns {QuestionTypeInfo | null}
 */
export function questionTypeInfo(type) {
  const code = normalizeQuestionType(type);
  return QUESTION_TYPES.find(entry => entry.code === code) || null;
}

/** @param {unknown} type */
export const isOptionBased = type => questionTypeInfo(type)?.optionBased === true;

/** @param {unknown} type */
export const questionTypeLabel = type => questionTypeInfo(type)?.label || normalizeQuestionType(type);

/**
 * Splits questions into blocks: a paragraph set (same details.passage.key) is
 * one block in first-appearance order; every other question is its own block.
 * @template {{ details?: import('./types').QuestionDetails | null } | null | undefined} Q
 * @param {readonly Q[]} questions
 * @returns {Q[][]}
 */
export function passageBlocks(questions) {
  /** @type {Map<string, Q[]>} */
  const blocks = new Map();
  questions.forEach((question, index) => {
    const key = question?.details?.passage?.key ? `p:${question.details.passage.key}` : `q:${index}`;
    const block = blocks.get(key);
    if (block) block.push(question);
    else blocks.set(key, [question]);
  });
  return [...blocks.values()];
}

/**
 * Canonical multiple-correct value ("0,2"), or null when nothing is chosen.
 * @param {Iterable<number>} indices
 * @returns {string | null}
 */
export function encodeOptionSet(indices) {
  const unique = [...new Set([...indices].filter(index => Number.isInteger(index) && index >= 0))].sort((a, b) => a - b);
  return unique.length ? unique.join(',') : null;
}

/**
 * Option indices in a stored answer: "0,2", "2" or 2.
 * @param {unknown} value
 * @returns {number[]}
 */
export function decodeOptionSet(value) {
  if (value === null || value === undefined || value === '') return [];
  return String(value).split(',').map(part => Number(part)).filter(index => Number.isInteger(index) && index >= 0);
}

/**
 * Same grammar as the database's is_canonical_option_set.
 * @param {unknown} value
 * @param {number} optionCount
 */
export function isCanonicalOptionSet(value, optionCount) {
  if (typeof value !== 'string' || !/^\d(,\d){0,9}$/.test(value)) return false;
  const indices = value.split(',').map(Number);
  return indices.every((index, position) => index < optionCount && (position === 0 || index > indices[position - 1]));
}

/**
 * Author-side correct-answer grammar, as in the database's is_valid_correct_answer.
 * @param {unknown} type
 * @param {unknown} answer
 */
export function isValidAuthorAnswer(type, answer) {
  const text = String(answer ?? '').trim();
  switch (normalizeQuestionType(type)) {
    case 'MULTIPLE_CORRECT': return isCanonicalOptionSet(text, 4);
    case 'INTEGER': return /^[+-]?\d+$/.test(text) && text.length <= AUTHOR_NUMERICAL_MAX_LENGTH;
    case 'NUMERICAL': return isValidNumericalAnswer(text, AUTHOR_NUMERICAL_MAX_LENGTH);
    case 'MCQ':
    case 'MATRIX_MATCH':
    case 'ASSERTION_REASON': return /^[0-3]$/.test(text);
    default: return false;
  }
}

/**
 * @param {UntrustedInput} lists
 * @returns {string | null}
 */
function matchListsError(lists) {
  if (!lists || typeof lists !== 'object' || Array.isArray(lists)
      || Object.keys(lists).some(key => key !== 'left' && key !== 'right')) {
    return 'List-I and List-II are invalid';
  }
  for (const [name, max] of /** @type {const} */ ([['left', 6], ['right', 8]])) {
    const items = lists[name];
    if (!Array.isArray(items) || items.length < 2 || items.length > max) {
      return name === 'left' ? 'List-I must have 2 to 6 items' : 'List-II must have 2 to 8 items';
    }
    if (items.some(item => typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 2000)) {
      return 'Every List-I and List-II item needs 1 to 2000 characters';
    }
  }
  return null;
}

/**
 * Same rules as the database's question_details_error. Null when valid.
 * @param {unknown} type
 * @param {UntrustedInput} details
 * @returns {string | null}
 */
export function validateQuestionDetails(type, details) {
  const isMatrix = normalizeQuestionType(type) === 'MATRIX_MATCH';
  if (details === null || details === undefined) {
    return isMatrix ? 'Matrix match questions require List-I and List-II' : null;
  }
  if (typeof details !== 'object' || Array.isArray(details)) return 'Question details must be an object';
  if (Object.keys(details).some(key => key !== 'matchLists' && key !== 'passage')) {
    return 'Question details contain unsupported fields';
  }
  if ('matchLists' in details) {
    if (!isMatrix) return 'Only matrix match questions can have List-I and List-II';
    const error = matchListsError(details.matchLists);
    if (error) return error;
  } else if (isMatrix) {
    return 'Matrix match questions require List-I and List-II';
  }
  if ('passage' in details) {
    const passage = details.passage;
    const valid = passage && typeof passage === 'object' && !Array.isArray(passage)
      && Object.keys(passage).every(key => key === 'key' || key === 'text')
      && UUID.test(String(passage.key || ''))
      && typeof passage.text === 'string'
      && passage.text.trim().length >= 1 && passage.text.trim().length <= 10000;
    if (!valid) return 'The paragraph must have a valid key and 1 to 10000 characters of text';
  }
  return null;
}

/**
 * Marks for one question type: the exam's per-type entry, else the exam-wide
 * marks (as in the database's resolve_question_marking).
 * @param {{ marksCorrect?: unknown, marksIncorrect?: unknown, marking?: ExamMarking | null } | null | undefined} paper
 * @param {unknown} type
 * @returns {ResolvedMarking}
 */
export function resolveMarking(paper, type) {
  const code = /** @type {QuestionTypeCode} */ (normalizeQuestionType(type));
  const entry = paper?.marking?.[code] || {};
  /** @type {(value: unknown, fallback: number) => number} */
  const numberOr = (value, fallback) => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));
  return {
    correct: numberOr(entry.correct, numberOr(paper?.marksCorrect, 4)),
    incorrect: numberOr(entry.incorrect, numberOr(paper?.marksIncorrect, -1)),
    partial: typeof entry.partial === 'boolean' ? entry.partial : true
  };
}

/** @param {number} value */
const hasAtMostTwoDecimals = value => Math.round(value * 100) / 100 === value;

/**
 * Problems in an optional per-type marking object (same rules as the
 * database's normalize_exam_marking). Empty when valid.
 * @param {UntrustedInput} marking
 * @returns {string[]}
 */
export function validateMarking(marking) {
  if (marking === undefined || marking === null) return [];
  if (typeof marking !== 'object' || Array.isArray(marking)) return ['Marking must be an object keyed by question type.'];
  /** @type {string[]} */
  const errors = [];
  for (const [code, entry] of Object.entries(marking)) {
    const info = questionTypeInfo(code);
    if (!info || code !== info.code) {
      errors.push(`Marking has an unsupported question type "${code}".`);
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['correct', 'incorrect', 'partial'].includes(key))) {
      errors.push(`Marking for ${code} is invalid.`);
      continue;
    }
    if ('correct' in entry && !(typeof entry.correct === 'number' && entry.correct > 0 && entry.correct <= 100 && hasAtMostTwoDecimals(entry.correct))) {
      errors.push(`${info.label}: marks for a correct answer must be greater than 0 and at most 100, with at most two decimal places.`);
    }
    if ('incorrect' in entry && !(typeof entry.incorrect === 'number' && entry.incorrect >= -100 && entry.incorrect <= 0 && hasAtMostTwoDecimals(entry.incorrect))) {
      errors.push(`${info.label}: marks for a wrong answer must be between -100 and 0, with at most two decimal places.`);
    }
    if ('partial' in entry) {
      if (code !== 'MULTIPLE_CORRECT') errors.push('Partial marks can only be set for multiple-correct questions.');
      else if (typeof entry.partial !== 'boolean') errors.push('Partial marks must be true or false.');
    }
  }
  return errors;
}

/**
 * Human-readable answer for review screens: "B. Beta", "A. Alpha; C. Gamma",
 * or the typed value. Empty string when there is no answer.
 * @param {{ type?: unknown, options?: unknown }} question
 * @param {unknown} value
 * @returns {string}
 */
export function formatAnswer(question, value) {
  if (value === null || value === undefined || value === '') return '';
  if (!isOptionBased(question?.type)) return String(value);
  const options = Array.isArray(question?.options) ? question.options : [];
  return decodeOptionSet(value)
    .map(index => `${String.fromCharCode(65 + index)}.${options[index] ? ` ${options[index]}` : ''}`)
    .join('; ');
}
