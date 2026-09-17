import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMPORT_QUESTIONS,
  buildAtomicImportPayload,
  canonicalQuestionText,
  parseImportDocument,
  validateImportQuestions
} from '../src/importLogic.js';

const validMcq = (overrides = {}) => ({
  question_number: 1,
  question_text: 'What is $2 + 2$?',
  question_type: 'MCQ',
  options: [
    { label: 'A', text: '2' },
    { label: 'B', text: '3' },
    { label: 'C', text: '4' },
    { label: 'D', text: '5' }
  ],
  correct_answer: 'C',
  subject: 'Mathematics',
  has_image_or_diagram: false,
  ...overrides
});

test('question import accepts and normalizes a valid MCQ without changing answer meaning', () => {
  const questions = parseImportDocument({ version: '1.0', questions: [validMcq()] });
  assert.equal(questions[0].correctAnswer, '2');
  assert.equal(questions[0].approved, true);
  assert.deepEqual(buildAtomicImportPayload(questions)[0].options, ['2', '3', '4', '5']);
});

test('question import rejects empty, oversized and structurally invalid documents', () => {
  assert.throws(() => parseImportDocument(null), /Invalid JSON structure/);
  assert.throws(() => parseImportDocument({ version: '2.0', questions: [] }), /version '1.0'/);
  assert.throws(() => parseImportDocument({ version: '1.0', questions: [] }), /empty/);
  assert.throws(
    () => parseImportDocument({ version: '1.0', questions: Array.from({ length: MAX_IMPORT_QUESTIONS + 1 }, validMcq) }),
    /limited to 500/
  );
});

test('missing type and subject are blocking instead of silently defaulted', () => {
  const [question] = parseImportDocument({
    version: '1.0',
    questions: [validMcq({ question_type: undefined, subject: undefined })]
  });
  assert.equal(question.approved, false);
  assert.match(question.warnings.join(' '), /Subject must/);
  assert.match(question.warnings.join(' '), /Question type must/);
});

test('duplicates use Unicode and whitespace normalization and cannot be approved', () => {
  assert.equal(canonicalQuestionText('  VALUE\u00a0  OF  Ｘ  '), canonicalQuestionText('value of X'));
  const questions = parseImportDocument({
    version: '1.0',
    questions: [validMcq({ question_text: 'Value  of X' }), validMcq({ question_text: ' value of x ' })]
  });
  assert.ok(questions.every(question => !question.approved));
  assert.ok(questions.every(question => question.warnings.some(warning => warning.includes('more than once'))));

  const [existing] = parseImportDocument(
    { version: '1.0', questions: [validMcq({ question_text: ' Existing\tquestion ' })] },
    [{ text: 'existing question' }]
  );
  assert.equal(existing.approved, false);
});

test('MCQ option labels, uniqueness, lengths and answers are strict', () => {
  const [question] = parseImportDocument({
    version: '1.0',
    questions: [validMcq({
      options: [
        { label: 'A', text: 'same' },
        { label: 'C', text: 'same' },
        { label: 'C', text: '' },
        { label: 'D', text: 'x'.repeat(5001) }
      ],
      correct_answer: 'E'
    })]
  });
  assert.equal(question.approved, false);
  assert.match(question.warnings.join(' '), /label "B"/);
  assert.match(question.warnings.join(' '), /unique/);
  assert.match(question.warnings.join(' '), /5,000/);
  assert.match(question.warnings.join(' '), /Correct answer/);
});

test('numerical questions require no options and preserve zero', () => {
  const [valid] = parseImportDocument({
    version: '1.0',
    questions: [validMcq({ question_type: 'NUMERICAL', options: [], correct_answer: 0, subject: 'physics' })]
  });
  assert.equal(valid.correctAnswer, '0');
  assert.equal(valid.subject, 'Physics');
  assert.equal(valid.approved, true);

  const [invalid] = validateImportQuestions([{ ...valid, options: ['stale'], correctAnswer: 'Infinity' }]);
  assert.equal(invalid.approved, false);
  assert.match(invalid.warnings.join(' '), /empty options array/);
  assert.match(invalid.warnings.join(' '), /valid number/);
});
