import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_FILE_NAME_LENGTH,
  exportFailedImportRows,
  validateImportConfirmation,
  validateImportFile,
  validateImportQuestions
} from '../src/importLogic.js';

const validQuestion = (overrides = {}) => ({
  id: 'row-1',
  question_number: 41,
  question_text: 'What is $1+1$?',
  question_type: 'MCQ',
  options: ['1', '2', '3', '4'],
  correct_answer: 'B',
  subject: 'Physics',
  has_image_or_diagram: false,
  ...overrides
});

test('revalidation preserves explicit exclusions and original source row numbers', () => {
  const [initial] = validateImportQuestions([validQuestion()]);
  assert.equal(initial.approved, true);
  assert.equal(initial.rowNumber, 41);

  const [excluded] = validateImportQuestions([{ ...initial, approved: false, text: 'Edited question text' }]);
  assert.equal(excluded.approved, false);
  assert.equal(excluded.rowNumber, 41);
  assert.equal(excluded.text, 'Edited question text');
});

test('fixing an invalid row requires deliberate approval instead of silently selecting it', () => {
  const [invalid] = validateImportQuestions([validQuestion({ question_text: '' })]);
  assert.equal(invalid.approved, false);
  const [fixed] = validateImportQuestions([{ ...invalid, text: 'Now valid' }]);
  assert.deepEqual(fixed.warnings, []);
  assert.equal(fixed.approved, false);
});

test('failed-row export excludes valid rows that were merely unchecked', () => {
  const validUnchecked = { ...validateImportQuestions([validQuestion()])[0], approved: false };
  const invalid = validateImportQuestions([validQuestion({ question_number: 42, question_text: '' })])[0];
  const exported = JSON.parse(exportFailedImportRows([validUnchecked, invalid]));
  assert.equal(exported.export_metadata.total_failed_rows, 1);
  assert.equal(exported.questions[0].question_number, 42);
});

test('file validation rejects empty, oversized, misnamed, and overlong selections', () => {
  assert.match(validateImportFile({ name: 'questions.txt', size: 10 }).error, /Only reviewed JSON/);
  assert.match(validateImportFile({ name: 'questions.json', size: 0 }).error, /empty/);
  assert.match(validateImportFile({ name: 'questions.json', size: MAX_IMPORT_FILE_BYTES + 1 }).error, /larger than 5 MB/);
  assert.match(validateImportFile({ name: `${'x'.repeat(MAX_IMPORT_FILE_NAME_LENGTH)}.json`, size: 10 }).error, /must not exceed/);
  assert.deepEqual(validateImportFile({ name: ' questions.JSON ', size: 10 }), { valid: true, fileName: 'questions.JSON' });
});

test('server confirmation must match both count and recovery batch ID', () => {
  assert.deepEqual(validateImportConfirmation({ imported: '2', batch_id: 'batch-1', idempotent: true }, 2, 'batch-1'), {
    imported: 2,
    idempotent: true
  });
  assert.throws(() => validateImportConfirmation({ imported: 1, batch_id: 'batch-1' }, 2, 'batch-1'), /unexpected imported-question count/);
  assert.throws(() => validateImportConfirmation({ imported: 2, batch_id: 'batch-2' }, 2, 'batch-1'), /unexpected import batch ID/);
});

test('import UI is latest-file-wins, single-flight, accessible, and commit-aware', async () => {
  const source = await readFile(new URL('../src/components/AIQuestionImporter.jsx', import.meta.url), 'utf8');
  assert.match(source, /activeFileReaderRef\.current\?\.abort\(\)/);
  assert.match(source, /generation !== fileReadGenerationRef\.current/);
  assert.match(source, /setFileName\(fileValidation\.fileName\)/);
  assert.match(source, /importInFlightRef\.current/);
  assert.match(source, /validateImportQuestions\(questions, questionBank\)/);
  assert.match(source, /validateImportConfirmation/);
  assert.match(source, /may have committed before the connection failed/);
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /\.abortSignal\(controller\.signal\)/);
  assert.match(source, /previous\.filter\(question => question\.id !== id\)/);
  assert.doesNotMatch(source, /Nothing was imported/);
  assert.match(source, /role="button"/);
  assert.match(source, /aria-busy=\{readingFile\}/);
  assert.match(source, /aria-pressed=\{filterTab === 'ALL'\}/);
});
