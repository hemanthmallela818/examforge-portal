import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtomicImportPayload, exportFailedImportRows, parseImportDocument } from '../src/importLogic.js';

const OPTIONS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
let counter = 0;
const row = (overrides) => ({
  question_number: ++counter,
  question_text: `Question ${counter}`,
  question_type: 'MCQ',
  options: OPTIONS,
  correct_answer: 'A',
  subject: 'Physics',
  has_image_or_diagram: false,
  ...overrides
});
const parse = (questions, bank = []) => parseImportDocument({ version: '1.0', questions }, bank);
const codes = (question) => question.rowErrors.map((error) => error.code);

test('multiple-correct answers accept letters, arrays or indices and store "0,2"', () => {
  const [letters, array, indices, bad] = parse([
    row({ question_type: 'MULTIPLE_CORRECT', correct_answer: 'A, C' }),
    row({ question_type: 'MULTIPLE_CORRECT', correct_answer: ['D', 'B'] }),
    row({ question_type: 'MULTIPLE_CORRECT', correct_answer: '0,2,3' }),
    row({ question_type: 'MULTIPLE_CORRECT', correct_answer: 'A,E' })
  ]);
  assert.equal(letters.correctAnswer, '0,2');
  assert.equal(letters.approved, true, letters.warnings.join(' '));
  assert.equal(array.correctAnswer, '1,3');
  assert.equal(indices.correctAnswer, '0,2,3');
  assert.deepEqual(codes(bad), ['ROW_INVALID_MULTI_ANSWER']);
});

test('integer, assertion-reason and matrix-match rows are validated', () => {
  const [integer, decimal, withOptions, assertion, matrix, noLists] = parse([
    row({ question_type: 'INTEGER', options: [], correct_answer: '-12' }),
    row({ question_type: 'INTEGER', options: [], correct_answer: '2.5' }),
    row({ question_type: 'INTEGER', correct_answer: '2' }),
    row({ question_type: 'ASSERTION_REASON', correct_answer: 'B' }),
    row({ question_type: 'MATRIX_MATCH', correct_answer: 'C', match_lists: { list_i: ['Force', 'Power'], list_ii: ['Newton', 'Watt', 'Joule'] } }),
    row({ question_type: 'MATRIX_MATCH', correct_answer: 'C' })
  ]);
  assert.equal(integer.approved, true, integer.warnings.join(' '));
  assert.deepEqual(codes(decimal), ['ROW_INVALID_INTEGER_ANSWER']);
  assert.ok(codes(withOptions).includes('ROW_NUMERICAL_NONEMPTY_OPTIONS'));
  assert.equal(assertion.correctAnswer, '1');
  assert.equal(assertion.approved, true, assertion.warnings.join(' '));
  assert.deepEqual(matrix.matchLists, { left: ['Force', 'Power'], right: ['Newton', 'Watt', 'Joule'] });
  assert.equal(matrix.approved, true, matrix.warnings.join(' '));
  assert.deepEqual(codes(noLists), ['ROW_INVALID_MATCH_LISTS']);
});

test('paragraph rows must share identical text, and duplicates respect lists and paragraphs', () => {
  const stem = 'Match List-I with List-II.';
  const rows = parse([
    row({ question_text: 'What is the speed?', passage: { key: 'P1', text: 'A car moves.' } }),
    row({ question_text: 'What is the speed?', passage: { key: 'P2', text: 'A train moves.' } }),
    row({ question_text: 'What is the time?', passage: { key: 'P2', text: 'A train moves!' } }),
    row({ question_type: 'MATRIX_MATCH', question_text: stem, match_lists: { list_i: ['a', 'b'], list_ii: ['c', 'd'] } }),
    row({ question_type: 'MATRIX_MATCH', question_text: stem, match_lists: { list_i: ['e', 'f'], list_ii: ['c', 'd'] } }),
    row({ question_text: 'Same child', passage: { key: 'P3', text: 'Shared' } }),
    row({ question_text: 'Same child', passage: { key: 'P3', text: 'Shared' } })
  ]);
  assert.deepEqual(codes(rows[0]), []);
  assert.deepEqual(codes(rows[1]), ['ROW_PASSAGE_MISMATCH']);
  assert.deepEqual(codes(rows[2]), ['ROW_PASSAGE_MISMATCH']);
  assert.deepEqual(codes(rows[3]), []);
  assert.deepEqual(codes(rows[4]), []);
  assert.deepEqual(codes(rows[5]), ['ROW_DUPLICATE_IN_FILE']);

  const [invalidPassage] = parse([row({ question_text: 'Orphan', passage: { key: '', text: 'x' } })]);
  assert.deepEqual(codes(invalidPassage), ['ROW_INVALID_PASSAGE']);

  const bank = [{ id: 'b1', text: stem, details: { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } } }];
  const [dup, fresh] = parse([
    row({ question_type: 'MATRIX_MATCH', question_text: stem, match_lists: { list_i: ['a', 'b'], list_ii: ['c', 'd'] } }),
    row({ question_type: 'MATRIX_MATCH', question_text: stem, match_lists: { list_i: ['x', 'y'], list_ii: ['c', 'd'] } })
  ], bank);
  assert.deepEqual(codes(dup), ['ROW_DUPLICATE_QUESTION_BANK']);
  assert.deepEqual(codes(fresh), []);
});

test('the import payload maps each paragraph key to one fresh UUID and carries details', () => {
  const parsed = parse([
    row({ question_type: 'MULTIPLE_CORRECT', correct_answer: 'A,B', passage: { key: 'P1', text: 'Shared text' } }),
    row({ question_type: 'INTEGER', options: [], correct_answer: '7', passage: { key: 'P1', text: 'Shared text' } }),
    row({ question_type: 'MATRIX_MATCH', correct_answer: 'D', match_lists: { list_i: ['a', 'b'], list_ii: ['c', 'd'] } }),
    row({ correct_answer: 'B' })
  ]);
  const payload = buildAtomicImportPayload(parsed);
  assert.equal(payload.length, 4);
  const [multi, integer, matrix, plain] = payload;
  assert.match(multi.details.passage.key, /^[0-9a-f-]{36}$/);
  assert.equal(multi.details.passage.key, integer.details.passage.key);
  assert.equal(multi.details.passage.text, 'Shared text');
  assert.equal(multi.correct_answer, '0,1');
  assert.deepEqual(multi.options, OPTIONS);
  assert.deepEqual(integer.options, []);
  assert.deepEqual(matrix.details, { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } });
  assert.equal('details' in plain, false);
  const again = buildAtomicImportPayload(parsed);
  assert.notEqual(again[0].details.passage.key, multi.details.passage.key, 'every import creates new paragraph sets');
});

test('failed rows are exported back in the reviewed file format', () => {
  const parsed = parse([
    row({ question_type: 'MULTIPLE_CORRECT', correct_answer: 'A,C', subject: 'Biology', passage: { key: 'P9', text: 'Para' } }),
    row({ question_type: 'MATRIX_MATCH', correct_answer: 'B', subject: 'Biology', match_lists: { list_i: ['a', 'b'], list_ii: ['c', 'd'] } })
  ]);
  const exported = JSON.parse(exportFailedImportRows(parsed)).questions;
  assert.equal(exported[0].correct_answer, 'A,C');
  assert.deepEqual(exported[0].passage, { key: 'P9', text: 'Para' });
  assert.equal(exported[0].options.length, 4);
  assert.equal(exported[1].correct_answer, 'B');
  assert.deepEqual(exported[1].match_lists, { list_i: ['a', 'b'], list_ii: ['c', 'd'] });
  const reparsed = parse(exported.map(({ diagnostics: _diagnostics, ...rest }) => ({ ...rest, subject: "Physics" })));
  assert.equal(reparsed[0].correctAnswer, '0,2');
  assert.deepEqual(reparsed[1].matchLists, { left: ['a', 'b'], right: ['c', 'd'] });
});
