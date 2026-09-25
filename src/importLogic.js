import { AUTHOR_NUMERICAL_MAX_LENGTH, isValidNumericalAnswer } from './numericalAnswerPolicy.js';

/**
 * @import {
 *   AtomicImportRow, ImportFileLike, ImportFileValidation, ImportOptions, ImportQuestion,
 *   ImportRowError, QuestionTextLike, UntrustedInput, ValidatedImportQuestion
 * } from './types'
 */

export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_QUESTIONS = 500;
export const MAX_IMPORT_FILE_NAME_LENGTH = 255;
export const MAX_IMPORT_JSON_DEPTH = 12;
// A schema-valid 500-row MCQ document contains more than 10,000 primitive and
// container nodes. Keep the traversal bounded without rejecting the supported
// maximum batch size.
export const MAX_IMPORT_JSON_NODES = 25000;
export const MAX_IMPORT_JSON_STRING_LENGTH = 10000;
// Default subjects for installations that have not configured their own. The app
// passes the administrator-configured list via `options.allowedSubjects`.
/** @type {readonly string[]} */
export const ALLOWED_IMPORT_SUBJECTS = Object.freeze(['Physics', 'Chemistry', 'Mathematics']);

/**
 * Trimmed, de-duplicated (case-insensitive) subject list, or the defaults.
 * @param {unknown} list
 * @returns {readonly string[]}
 */
export const resolveAllowedSubjects = list => {
  if (!Array.isArray(list)) return ALLOWED_IMPORT_SUBJECTS;
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const cleaned = [];
  for (const entry of list) {
    const name = String(entry ?? '').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    cleaned.push(name);
  }
  return cleaned.length > 0 ? cleaned : ALLOWED_IMPORT_SUBJECTS;
};

/**
 * "A", "A or B", "A, B, or C"
 * @param {unknown} list
 * @returns {string}
 */
export const formatSubjectList = list => {
  const items = resolveAllowedSubjects(list);
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
};

/**
 * @param {unknown} list
 * @returns {string}
 */
export const subjectRequirementMessage = list => `Subject must be ${formatSubjectList(list)}.`;

export const IMPORT_EXAMPLE_DOCUMENT = Object.freeze({
  version: '1.0',
  questions: [
    {
      id: 'physics-mcq-001',
      question_number: 1,
      question_text: 'A particle has speed $v$. Which expression is its kinetic energy?',
      question_type: 'MCQ',
      options: [
        { label: 'A', text: '$mv$' },
        { label: 'B', text: '$\\frac{1}{2}mv^2$' },
        { label: 'C', text: '$mv^2$' },
        { label: 'D', text: '$\\frac{1}{2}m^2v$' }
      ],
      correct_answer: 'B',
      subject: 'Physics',
      has_image_or_diagram: false
    },
    {
      id: 'mathematics-numerical-001',
      question_number: 2,
      question_text: 'Evaluate $\\int_{-1}^{1} x^3\\,dx$.',
      question_type: 'NUMERICAL',
      options: [],
      correct_answer: '0',
      subject: 'Mathematics',
      has_image_or_diagram: false
    }
  ]
});

export const IMPORT_JSON_SCHEMA_DOCUMENT = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.invalid/schemas/reviewed-jee-question-import-v1.schema.json',
  title: 'Reviewed JEE question import',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'questions'],
  properties: {
    version: { const: '1.0' },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_IMPORT_QUESTIONS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'question_number', 'question_text', 'question_type', 'options',
          'correct_answer', 'subject', 'has_image_or_diagram'
        ],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 128 },
          question_number: { type: 'integer', minimum: 1 },
          question_text: { type: 'string', minLength: 1, maxLength: 10000 },
          question_type: { enum: ['MCQ', 'NUMERICAL'] },
          options: {
            type: 'array',
            maxItems: 4,
            items: {
              oneOf: [
                { type: 'string', minLength: 1, maxLength: 5000 },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['label', 'text'],
                  properties: {
                    label: { enum: ['A', 'B', 'C', 'D'] },
                    text: { type: 'string', minLength: 1, maxLength: 5000 }
                  }
                }
              ]
            }
          },
          correct_answer: { type: ['string', 'number'], maxLength: 100 },
          subject: { enum: ALLOWED_IMPORT_SUBJECTS },
          has_image_or_diagram: { type: 'boolean' }
        }
      }
    }
  }
});

const SOURCE_QUESTION_KEYS = new Set([
  'id', 'question_number', 'question_text', 'question_type', 'options',
  'correct_answer', 'subject', 'has_image_or_diagram'
]);

/**
 * @param {unknown} value
 * @returns {string} Problem description, or '' when balanced.
 */
const checkLatexDelimiters = value => {
  const text = String(value ?? '');
  const sanitized = text.replace(/\\\$/g, '');
  const displayCount = (sanitized.match(/\$\$/g) || []).length;
  if (displayCount % 2 !== 0) return 'Unmatched display math delimiter ($$).';
  const inlineCount = (sanitized.replace(/\$\$/g, '').match(/\$/g) || []).length;
  return inlineCount % 2 !== 0 ? 'Unmatched inline math delimiter ($).' : '';
};

/**
 * Throws when parsed JSON is too deep, too large, or uses unsafe keys.
 * @param {unknown} root
 */
const assertImportJsonComplexity = root => {
  /** @type {Array<{ value: unknown, depth: number }>} */
  const stack = [{ value: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const { value, depth } = /** @type {{ value: unknown, depth: number }} */ (stack.pop());
    visited += 1;
    if (visited > MAX_IMPORT_JSON_NODES) throw new Error('JSON contains too many nested values. Split the import into smaller files.');
    if (depth > MAX_IMPORT_JSON_DEPTH) throw new Error(`JSON nesting exceeds the supported depth of ${MAX_IMPORT_JSON_DEPTH}.`);
    if (typeof value === 'string' && value.length > MAX_IMPORT_JSON_STRING_LENGTH) {
      throw new Error(`JSON contains a string longer than ${MAX_IMPORT_JSON_STRING_LENGTH.toLocaleString('en-US')} characters.`);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_IMPORT_QUESTIONS) throw new Error(`JSON arrays are limited to ${MAX_IMPORT_QUESTIONS} entries.`);
      value.forEach(item => stack.push({ value: item, depth: depth + 1 }));
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 32) throw new Error('A JSON object contains too many fields. Use the reviewed import schema.');
      entries.forEach(([key, item]) => {
        if (key.length > 64 || ['__proto__', 'prototype', 'constructor'].includes(key)) {
          throw new Error('JSON contains an unsupported or unsafe field name.');
        }
        stack.push({ value: item, depth: depth + 1 });
      });
    }
  }
};

/**
 * Normalised text used for duplicate detection.
 * @param {unknown} value
 * @returns {string}
 */
export const canonicalQuestionText = value => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/\s+/gu, ' ')
  .toLocaleLowerCase('en-US');

/**
 * @param {UntrustedInput} option String or `{ label, text }`.
 * @returns {string}
 */
const normalizeOption = option => {
  if (typeof option === 'string') return option.trim();
  if (option && typeof option === 'object' && typeof option.text === 'string') return option.text.trim();
  return '';
};

/**
 * MCQ letters A-D become '0'-'3'; anything else is returned trimmed.
 * @param {unknown} value
 * @param {string} type
 * @returns {string}
 */
const normalizeCorrectAnswer = (value, type) => {
  const answer = String(value ?? '').trim();
  if (type !== 'MCQ') return answer;
  const upper = answer.toUpperCase();
  return /^[A-D]$/.test(upper) ? String(upper.charCodeAt(0) - 65) : answer;
};

/**
 * @param {unknown} value
 * @param {readonly string[]} allowedSubjects
 * @returns {string} Canonical casing when allowed, otherwise the trimmed input.
 */
const normalizeSubject = (value, allowedSubjects) => {
  const trimmed = String(value ?? '').trim();
  return allowedSubjects.find(subject => subject.toLowerCase() === trimmed.toLowerCase()) || trimmed;
};

/**
 * @param {UntrustedInput} raw One source row (reviewed schema or editor shape).
 * @param {number} index
 * @param {boolean} [strictSource]
 * @param {readonly string[]} [allowedSubjects]
 * @returns {ImportQuestion}
 */
const normalizeRawQuestion = (raw, index, strictSource = false, allowedSubjects = ALLOWED_IMPORT_SUBJECTS) => {
  const rawType = String(raw?.question_type ?? raw?.type ?? '').trim().toUpperCase();
  // 'NAT' (Numerical Answer Type) is a canonical alias for NUMERICAL across the
  // database (migration 20260910110000), the exam preflight, and the question
  // archive. Normalize it on ingest so valid numeric questions aren't rejected
  // as an unknown type.
  const type = rawType === 'NAT' ? 'NUMERICAL' : rawType;
  const rawOptions = Array.isArray(raw?.options) ? raw.options : [];
  /** @type {string[]} */
  const schemaWarnings = strictSource
    ? []
    : (Array.isArray(raw?.schemaWarnings) ? raw.schemaWarnings.map(String) : []);
  const hasPreservedSourceId = raw && Object.prototype.hasOwnProperty.call(raw, 'sourceId');
  const sourceId = hasPreservedSourceId
    ? String(raw.sourceId ?? '').trim()
    : (typeof raw?.id === 'string' ? raw.id.trim() : '');

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    schemaWarnings.push('Every question must be a JSON object.');
  }
  if (strictSource && raw && typeof raw === 'object') {
    Object.keys(raw).forEach(key => {
      if (!SOURCE_QUESTION_KEYS.has(key)) schemaWarnings.push(`Unsupported field "${key}". Use the reviewed JSON schema.`);
    });
  }
  if (raw?.id != null && (typeof raw.id !== 'string' || sourceId.length < 1 || sourceId.length > 128)) {
    schemaWarnings.push('Question id must be text between 1 and 128 characters when provided.');
  }
  if (raw?.question_number != null && (!Number.isInteger(Number(raw.question_number)) || Number(raw.question_number) < 1)) {
    schemaWarnings.push('question_number must be a positive integer.');
  }

  if (type === 'MCQ' && Array.isArray(raw?.options)) {
    raw.options.forEach((/** @type {UntrustedInput} */ option, /** @type {number} */ optionIndex) => {
      if (option && typeof option === 'object' && !Array.isArray(option)) {
        const expectedLabel = String.fromCharCode(65 + optionIndex);
        if (option.label !== expectedLabel || typeof option.text !== 'string') {
          schemaWarnings.push(`Option ${expectedLabel} must use label "${expectedLabel}" and contain text.`);
        }
      } else if (typeof option !== 'string') {
        schemaWarnings.push(`Option ${optionIndex + 1} must be text.`);
      }
    });
  }

  if (typeof raw?.has_image_or_diagram !== 'boolean' && typeof raw?.hasImageOrDiagram !== 'boolean') {
    schemaWarnings.push('has_image_or_diagram must be true or false.');
  }

  return {
    id: sourceId || raw?.id || `imported-${index}`,
    sourceId,
    rowNumber: (raw?.question_number ?? raw?.rowNumber) != null && !isNaN(Number(raw?.question_number ?? raw?.rowNumber))
      ? Number(raw?.question_number ?? raw?.rowNumber)
      : index + 1,
    text: String(raw?.question_text ?? raw?.text ?? '').trim(),
    type,
    options: rawOptions.map(normalizeOption),
    correctAnswer: normalizeCorrectAnswer(raw?.correct_answer ?? raw?.correctAnswer, type),
    subject: normalizeSubject(raw?.subject, allowedSubjects),
    hasImageOrDiagram: Boolean(raw?.has_image_or_diagram ?? raw?.hasImageOrDiagram),
    schemaWarnings,
    approved: typeof raw?.approved === 'boolean' ? raw.approved : undefined
  };
};

/**
 * @param {ImportQuestion} question
 * @param {readonly string[]} [allowedSubjects]
 * @returns {{ warnings: string[], rowErrors: ImportRowError[] }}
 */
const validateOne = (question, allowedSubjects = ALLOWED_IMPORT_SUBJECTS) => {
  const warnings = [...(question.schemaWarnings || [])];
  /** @type {ImportRowError[]} */
  const rowErrors = [];

  if (!allowedSubjects.includes(question.subject)) {
    const msg = subjectRequirementMessage(allowedSubjects);
    warnings.push(msg);
    rowErrors.push({ code: 'ROW_INVALID_SUBJECT', field: 'subject', message: msg });
  }
  if (!['MCQ', 'NUMERICAL'].includes(question.type)) {
    const msg = 'Question type must be MCQ or NUMERICAL.';
    warnings.push(msg);
    rowErrors.push({ code: 'ROW_INVALID_TYPE', field: 'type', message: msg });
  }
  if (!question.text) {
    const msg = 'Missing question text.';
    warnings.push(msg);
    rowErrors.push({ code: 'ROW_EMPTY_TEXT', field: 'text', message: msg });
  }
  if (question.text.length > 10000) {
    const msg = 'Question text must not exceed 10,000 characters.';
    warnings.push(msg);
    rowErrors.push({ code: 'ROW_TEXT_TOO_LONG', field: 'text', message: msg });
  }
  const promptLatexIssue = checkLatexDelimiters(question.text);
  if (promptLatexIssue) {
    const msg = `${promptLatexIssue} Fix the question text before approval.`;
    warnings.push(msg);
    rowErrors.push({ code: 'ROW_UNBALANCED_LATEX', field: 'text', message: msg });
  }

  if (question.type === 'MCQ') {
    if (question.options.length !== 4) {
      const msg = 'MCQ must have exactly 4 options.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_INVALID_OPTIONS_COUNT', field: 'options', message: msg });
    }
    if (question.options.some(option => !option)) {
      const msg = 'Every MCQ option must contain text.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_EMPTY_OPTION', field: 'options', message: msg });
    }
    if (question.options.some(option => option.length > 5000)) {
      const msg = 'Each MCQ option must not exceed 5,000 characters.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_OPTION_TOO_LONG', field: 'options', message: msg });
    }
    question.options.forEach((option, optionIndex) => {
      const optionLatexIssue = checkLatexDelimiters(option);
      if (optionLatexIssue) {
        const msg = `${optionLatexIssue} Fix option ${String.fromCharCode(65 + optionIndex)} before approval.`;
        warnings.push(msg);
        rowErrors.push({ code: 'ROW_UNBALANCED_OPTION_LATEX', field: 'options', message: msg });
      }
    });
    if (new Set(question.options.map(canonicalQuestionText)).size !== question.options.length) {
      const msg = 'MCQ options must be unique.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_DUPLICATE_OPTIONS', field: 'options', message: msg });
    }
    if (!/^[0-3]$/.test(question.correctAnswer)) {
      const msg = 'Correct answer must be A, B, C, or D (0, 1, 2, or 3).';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_INVALID_ANSWER', field: 'correctAnswer', message: msg });
    }
  } else if (question.type === 'NUMERICAL') {
    if (question.options.length !== 0) {
      const msg = 'Numerical questions must have an empty options array.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_NUMERICAL_NONEMPTY_OPTIONS', field: 'options', message: msg });
    }
    if (!isValidNumericalAnswer(question.correctAnswer, AUTHOR_NUMERICAL_MAX_LENGTH)) {
      const msg = 'Numerical question correct answer must be a valid number of at most 100 characters.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_INVALID_NUMERICAL_ANSWER', field: 'correctAnswer', message: msg });
    }
  }
  return { warnings, rowErrors };
};

/**
 * Normalises and validates rows, including duplicates against the bank and within the file.
 * @param {UntrustedInput[]} inputQuestions
 * @param {QuestionTextLike[]} [questionBank]
 * @param {ImportOptions} [options]
 * @returns {ValidatedImportQuestion[]}
 */
export const validateImportQuestions = (inputQuestions, questionBank = [], options = {}) => {
  if (!Array.isArray(inputQuestions)) throw new Error('Questions must be provided as an array.');
  const allowedSubjects = resolveAllowedSubjects(options.allowedSubjects);
  const normalized = inputQuestions.map((question, index) => normalizeRawQuestion(question, index, options.strictSource === true, allowedSubjects));
  const bankKeys = new Set((Array.isArray(questionBank) ? questionBank : []).map(question => canonicalQuestionText(question.text ?? question.question_text)).filter(Boolean));
  /** @type {Map<string, number>} */
  const uploadCounts = new Map();
  /** @type {Map<string, number>} */
  const sourceIdCounts = new Map();
  normalized.forEach(question => {
    const key = canonicalQuestionText(question.text);
    if (key) uploadCounts.set(key, (uploadCounts.get(key) || 0) + 1);
    if (question.sourceId) sourceIdCounts.set(question.sourceId, (sourceIdCounts.get(question.sourceId) || 0) + 1);
  });

  return normalized.map(question => {
    const { warnings, rowErrors } = validateOne(question, allowedSubjects);
    const key = canonicalQuestionText(question.text);
    if (key && bankKeys.has(key)) {
      const msg = 'A matching question already exists in the Question Bank.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_DUPLICATE_QUESTION_BANK', field: 'text', message: msg });
    }
    if (key && /** @type {number} */ (uploadCounts.get(key)) > 1) {
      const msg = 'This question appears more than once in the uploaded file.';
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_DUPLICATE_IN_FILE', field: 'text', message: msg });
    }
    if (question.sourceId && /** @type {number} */ (sourceIdCounts.get(question.sourceId)) > 1) {
      const msg = `Question id "${question.sourceId}" appears more than once in the uploaded file.`;
      warnings.push(msg);
      rowErrors.push({ code: 'ROW_DUPLICATE_SOURCE_ID', field: 'id', message: msg });
    }
    return {
      ...question,
      warnings: [...new Set(warnings)],
      rowErrors,
      approved: warnings.length === 0 && question.approved !== false,
      status: warnings.length === 0 ? 'VALID' : 'WARNING'
    };
  });
};

/**
 * @param {ImportFileLike | null | undefined} file
 * @returns {ImportFileValidation}
 */
export const validateImportFile = (file) => {
  if (!file || typeof file.name !== 'string' || !Number.isFinite(file.size) || file.size < 0) {
    return { valid: false, error: 'Select a valid JSON file.' };
  }
  const fileName = file.name.trim();
  if (!fileName.toLowerCase().endsWith('.json')) {
    return { valid: false, error: 'Only reviewed JSON files are accepted. PDF, image, text, OCR, and AI source files must be converted outside this portal.' };
  }
  const declaredType = String(file.type || '').trim().toLowerCase();
  if (declaredType && !['application/json', 'text/json', 'application/octet-stream'].includes(declaredType)) {
    return { valid: false, error: `The selected file is declared as ${declaredType}, not JSON. PDF, image, and text uploads are not accepted.` };
  }
  if (fileName.length > MAX_IMPORT_FILE_NAME_LENGTH) {
    return { valid: false, error: `The file name must not exceed ${MAX_IMPORT_FILE_NAME_LENGTH} characters.` };
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return { valid: false, error: 'The JSON file is larger than 5 MB. Split it into smaller imports.' };
  }
  if (file.size === 0) return { valid: false, error: 'The selected JSON file is empty.' };
  return { valid: true, fileName };
};

/**
 * @param {UntrustedInput} data Import RPC response `{ imported, batch_id, idempotent }`.
 * @param {number} expectedCount
 * @param {unknown} expectedBatchId
 * @returns {{ imported: number, idempotent: boolean }}
 */
export const validateImportConfirmation = (data, expectedCount, expectedBatchId) => {
  const imported = Number(data?.imported);
  if (!Number.isInteger(imported) || imported !== expectedCount) {
    throw new Error('The server returned an unexpected imported-question count. Retry the same batch to reconcile safely.');
  }
  if (String(data?.batch_id ?? '') !== String(expectedBatchId ?? '')) {
    throw new Error('The server returned an unexpected import batch ID. Retry the same batch to reconcile safely.');
  }
  return { imported, idempotent: data?.idempotent === true };
};

/**
 * @param {UntrustedInput} document Parsed `{ version: '1.0', questions: [...] }` document.
 * @param {QuestionTextLike[]} [questionBank]
 * @param {ImportOptions} [options]
 * @returns {ValidatedImportQuestion[]}
 */
export const parseImportDocument = (document, questionBank = [], options = {}) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Invalid JSON structure.');
  assertImportJsonComplexity(document);
  const topLevelKeys = Object.keys(document);
  if (topLevelKeys.some(key => !['version', 'questions'].includes(key))) {
    throw new Error('JSON contains unsupported top-level fields. Use the downloadable reviewed import schema.');
  }
  if (document.version !== '1.0' || !Array.isArray(document.questions)) {
    throw new Error("JSON must use version '1.0' and contain a questions array.");
  }
  if (document.questions.length === 0) throw new Error('The questions array is empty.');
  if (document.questions.length > MAX_IMPORT_QUESTIONS) {
    throw new Error(`A single import is limited to ${MAX_IMPORT_QUESTIONS} questions.`);
  }
  const validated = validateImportQuestions(document.questions, questionBank, { strictSource: true, allowedSubjects: options.allowedSubjects });
  return options.requireExplicitApproval === true
    ? validated.map(question => ({ ...question, approved: false }))
    : validated;
};

/**
 * @param {unknown} input UTF-8 decoded file text.
 * @param {QuestionTextLike[]} [questionBank]
 * @param {ImportOptions} [options]
 * @returns {ValidatedImportQuestion[]}
 */
export const parseImportJsonText = (input, questionBank = [], options = {}) => {
  if (typeof input !== 'string') throw new Error('The selected file could not be decoded as UTF-8 JSON text.');
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;
  if (!text.trim()) throw new Error('The selected JSON file is empty.');
  if (text.includes('\uFFFD') || text.includes('\u0000') || text.slice(1).includes('\uFEFF')) {
    throw new Error('The JSON file has invalid or unsupported text encoding. Save it as UTF-8 and try again.');
  }
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_FILE_BYTES) {
    throw new Error('The JSON file is larger than 5 MB. Split it into smaller imports.');
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('The JSON file is malformed or truncated. Fix the file and try again.');
  }
  return parseImportDocument(document, questionBank, options);
};

/**
 * @param {ValidatedImportQuestion[]} questions
 * @returns {AtomicImportRow[]}
 */
export const buildAtomicImportPayload = questions => questions.filter(question => question.approved).map(question => ({
  subject: question.subject,
  type: question.type,
  question_text: question.text,
  options: question.type === 'MCQ' ? question.options : [],
  correct_answer: question.correctAnswer,
  has_image_or_diagram: Boolean(question.hasImageOrDiagram),
  category: 'Mains',
  points: 4,
  neg_points: -1
}));

/**
 * @param {Array<Partial<ValidatedImportQuestion> & Pick<ImportQuestion, 'type' | 'correctAnswer'>>} questions
 * @returns {string} Pretty-printed JSON in the reviewed import format.
 */
export const exportFailedImportRows = (questions) => {
  const failedQuestions = questions.filter(q => (q.warnings?.length || 0) > 0 || (q.rowErrors?.length || 0) > 0);
  const exportPayload = {
    version: '1.0',
    export_metadata: {
      exported_at: new Date().toISOString(),
      total_failed_rows: failedQuestions.length,
      instructions: 'Fix errors in the questions below and re-upload to the Question Importer.'
    },
    questions: failedQuestions.map((q, idx) => {
      let ansLabel = q.correctAnswer;
      if (q.type === 'MCQ' && /^[0-3]$/.test(q.correctAnswer)) {
        ansLabel = String.fromCharCode(65 + Number(q.correctAnswer));
      }
      return {
        question_number: q.rowNumber || idx + 1,
        question_text: q.text,
        question_type: q.type,
        options: q.type === 'MCQ'
          ? (q.options || []).map((optText, optIdx) => ({
              label: String.fromCharCode(65 + optIdx),
              text: optText
            }))
          : [],
        correct_answer: ansLabel,
        subject: q.subject,
        has_image_or_diagram: Boolean(q.hasImageOrDiagram),
        diagnostics: {
          errors: q.warnings || []
        }
      };
    })
  };

  return JSON.stringify(exportPayload, null, 2);
};
