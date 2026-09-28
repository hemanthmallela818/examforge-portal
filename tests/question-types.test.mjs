import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSERTION_REASON_OPTIONS,
  ASSERTION_REASON_TEMPLATE,
  MATCH_LEFT_LABELS,
  MATCH_RIGHT_LABELS,
  QUESTION_TYPES,
  decodeOptionSet,
  encodeOptionSet,
  formatAnswer,
  isOptionBased,
  isValidAuthorAnswer,
  normalizeQuestionType,
  questionTypeInfo,
  resolveMarking,
  validateMarking,
  validateQuestionDetails
} from '../src/questionTypes.js';
import { validateIntegerAnswer } from '../src/numericalAnswerPolicy.js';
import { questionIdentityKey } from '../src/importLogic.js';

test('the registry lists the six authorable types in display order', () => {
  assert.deepEqual(QUESTION_TYPES.map((t) => t.code), [
    'MCQ', 'MULTIPLE_CORRECT', 'INTEGER', 'NUMERICAL', 'MATRIX_MATCH', 'ASSERTION_REASON'
  ]);
  assert.equal(questionTypeInfo('mcq').badge, 'MULTIPLE CHOICE');
  assert.equal(questionTypeInfo('NAT').code, 'NUMERICAL');
  assert.equal(questionTypeInfo('ESSAY'), null);
  assert.equal(isOptionBased('MATRIX_MATCH'), true);
  assert.equal(isOptionBased('INTEGER'), false);
  assert.equal(ASSERTION_REASON_OPTIONS.length, 4);
  assert.match(ASSERTION_REASON_TEMPLATE, /Assertion \(A\):[\s\S]*Reason \(R\):/);
  assert.deepEqual(MATCH_LEFT_LABELS, ['P', 'Q', 'R', 'S', 'T', 'U']);
  assert.equal(MATCH_RIGHT_LABELS.length, 8);
});

test('normalizeQuestionType never turns an unknown type into MCQ', () => {
  assert.equal(normalizeQuestionType(''), 'MCQ');
  assert.equal(normalizeQuestionType(null), 'MCQ');
  assert.equal(normalizeQuestionType('nat'), 'NUMERICAL');
  assert.equal(normalizeQuestionType(' multiple_correct '), 'MULTIPLE_CORRECT');
  assert.equal(normalizeQuestionType('essay'), 'ESSAY');
});

test('option sets encode canonically and decode leniently', () => {
  assert.equal(encodeOptionSet([2, 0, 2]), '0,2');
  assert.equal(encodeOptionSet([]), null);
  assert.equal(encodeOptionSet([3, 1]), '1,3');
  assert.deepEqual(decodeOptionSet('0,2'), [0, 2]);
  assert.deepEqual(decodeOptionSet(3), [3]);
  assert.deepEqual(decodeOptionSet(null), []);
  assert.deepEqual(decodeOptionSet(''), []);
});

test('author answers follow the same grammar as the database', () => {
  const cases = [
    ['MCQ', '3', true], ['MCQ', '4', false], ['MCQ', 'A', false],
    ['MULTIPLE_CORRECT', '0,2', true], ['MULTIPLE_CORRECT', '3', true], ['MULTIPLE_CORRECT', '0,1,2,3', true],
    ['MULTIPLE_CORRECT', '2,0', false], ['MULTIPLE_CORRECT', '0,0', false], ['MULTIPLE_CORRECT', '', false],
    ['MULTIPLE_CORRECT', '0,4', false], ['MULTIPLE_CORRECT', '0,,2', false],
    ['INTEGER', '-12', true], ['INTEGER', '+7', true], ['INTEGER', '2.5', false], ['INTEGER', '', false],
    ['NUMERICAL', '2.5', true], ['NUMERICAL', '1e3', false],
    ['MATRIX_MATCH', '2', true], ['ASSERTION_REASON', '0', true], ['ESSAY', '0', false]
  ];
  for (const [type, answer, expected] of cases) {
    assert.equal(isValidAuthorAnswer(type, answer), expected, `${type} ${answer}`);
  }
});

test('integer answers accept whole numbers and in-progress signs only', () => {
  assert.equal(validateIntegerAnswer('-12').valid, true);
  assert.equal(validateIntegerAnswer('').empty, true);
  assert.equal(validateIntegerAnswer('-').transient, true);
  const decimal = validateIntegerAnswer('2.5');
  assert.equal(decimal.valid, false);
  assert.equal(decimal.transient, false);
  assert.match(decimal.error, /whole number/);
  assert.match(validateIntegerAnswer('1'.repeat(65)).error, /at most 64/);
});

test('question details follow the same rules as the database', () => {
  const lists = { left: ['Force', 'Power'], right: ['Newton', 'Watt'] };
  const passage = { key: '00000000-0000-4000-8000-00000000cafe', text: 'A passage' };
  assert.equal(validateQuestionDetails('MATRIX_MATCH', { matchLists: lists }), null);
  assert.equal(validateQuestionDetails('MATRIX_MATCH', null), 'Matrix match questions require List-I and List-II');
  assert.equal(validateQuestionDetails('MCQ', { matchLists: lists }), 'Only matrix match questions can have List-I and List-II');
  assert.equal(validateQuestionDetails('MATRIX_MATCH', { matchLists: { left: ['a'], right: ['b', 'c'] } }), 'List-I must have 2 to 6 items');
  assert.equal(validateQuestionDetails('MATRIX_MATCH', { matchLists: { left: ['a', 'b'], right: Array(9).fill('x') } }), 'List-II must have 2 to 8 items');
  assert.equal(validateQuestionDetails('MATRIX_MATCH', { matchLists: { left: ['a', ' '], right: ['b', 'c'] } }), 'Every List-I and List-II item needs 1 to 2000 characters');
  assert.equal(validateQuestionDetails('INTEGER', { passage }), null);
  assert.match(validateQuestionDetails('MCQ', { passage: { key: 'P1', text: 'x' } }), /valid key/);
  assert.match(validateQuestionDetails('MCQ', { passage: { ...passage, text: '  ' } }), /valid key/);
  assert.equal(validateQuestionDetails('MCQ', { hint: 'x' }), 'Question details contain unsupported fields');
  assert.equal(validateQuestionDetails('MCQ', null), null);
});

test('duplicate keys include structured details', () => {
  const stem = 'Match List-I with List-II';
  const a = questionIdentityKey(stem, { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } });
  const b = questionIdentityKey(stem, { matchLists: { left: ['e', 'f'], right: ['c', 'd'] } });
  assert.notEqual(a, b);
  assert.equal(questionIdentityKey('  Same   TEXT ', null), questionIdentityKey('same text', undefined));
  assert.equal(
    questionIdentityKey('x', { passage: { text: 't', key: 'k' } }),
    questionIdentityKey('x', { passage: { key: 'k', text: 't' } }),
    'key order does not matter'
  );
});

test('resolveMarking mirrors the database fallbacks', () => {
  const paper = { marksCorrect: 4, marksIncorrect: -1, marking: { MULTIPLE_CORRECT: { correct: 4, incorrect: -2 }, NUMERICAL: { incorrect: 0 }, MCQ: { correct: 3 } } };
  assert.deepEqual(resolveMarking(paper, 'MCQ'), { correct: 3, incorrect: -1, partial: true });
  assert.deepEqual(resolveMarking(paper, 'MULTIPLE_CORRECT'), { correct: 4, incorrect: -2, partial: true });
  assert.deepEqual(resolveMarking(paper, 'NAT'), { correct: 4, incorrect: 0, partial: true });
  assert.deepEqual(resolveMarking(paper, 'INTEGER'), { correct: 4, incorrect: -1, partial: true });
  assert.deepEqual(resolveMarking({ marksCorrect: 2, marksIncorrect: 0, marking: { MULTIPLE_CORRECT: { partial: false } } }, 'MULTIPLE_CORRECT'), { correct: 2, incorrect: 0, partial: false });
  assert.deepEqual(resolveMarking({}, 'MCQ'), { correct: 4, incorrect: -1, partial: true });
  assert.deepEqual(resolveMarking({ marksCorrect: '3', marksIncorrect: '-1' }, 'MCQ'), { correct: 3, incorrect: -1, partial: true });
});

test('validateMarking mirrors the database rules', () => {
  assert.deepEqual(validateMarking(undefined), []);
  assert.deepEqual(validateMarking({ MCQ: { correct: 3, incorrect: -1 }, MULTIPLE_CORRECT: { partial: false } }), []);
  assert.match(validateMarking([1]).join(' '), /object keyed by question type/);
  assert.match(validateMarking({ ESSAY: {} }).join(' '), /unsupported question type "ESSAY"/);
  assert.match(validateMarking({ NAT: {} }).join(' '), /unsupported question type "NAT"/);
  assert.match(validateMarking({ MCQ: { bonus: 1 } }).join(' '), /Marking for MCQ is invalid/);
  assert.match(validateMarking({ MCQ: { correct: 0 } }).join(' '), /Single correct: marks for a correct answer/);
  assert.match(validateMarking({ MCQ: { correct: 3.555 } }).join(' '), /Single correct: marks for a correct answer/);
  assert.match(validateMarking({ MCQ: { correct: '3' } }).join(' '), /Single correct: marks for a correct answer/);
  assert.match(validateMarking({ INTEGER: { incorrect: 1 } }).join(' '), /Integer: marks for a wrong answer/);
  assert.match(validateMarking({ MCQ: { partial: true } }).join(' '), /only be set for multiple-correct/);
  assert.match(validateMarking({ MULTIPLE_CORRECT: { partial: 'yes' } }).join(' '), /true or false/);
});

test('formatAnswer renders every type for review screens', () => {
  const options = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  assert.equal(formatAnswer({ type: 'MCQ', options }, '1'), 'B. Beta');
  assert.equal(formatAnswer({ type: 'MCQ', options }, 2), 'C. Gamma');
  assert.equal(formatAnswer({ type: 'MULTIPLE_CORRECT', options }, '0,2'), 'A. Alpha; C. Gamma');
  assert.equal(formatAnswer({ type: 'INTEGER', options: [] }, '-12'), '-12');
  assert.equal(formatAnswer({ type: 'NAT', options: [] }, '2.5'), '2.5');
  assert.equal(formatAnswer({ type: 'MATRIX_MATCH', options }, '3'), 'D. Delta');
  assert.equal(formatAnswer({ type: 'MCQ', options }, null), '');
  assert.equal(formatAnswer({ type: 'MCQ', options: [] }, '1'), 'B.');
});

test('bank rows keep their real type and details instead of collapsing to MCQ', async () => {
  const { normalizeQuestionBankRow } = await import('../src/questionBankPaging.js');
  const details = { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } };
  const row = normalizeQuestionBankRow({ id: 'x', subject: 'Physics', type: 'MATRIX_MATCH', question_number: 1, question_text: 'Q', options: ['1', '2', '3', '4'], correct_answer: '0', details });
  assert.equal(row.type, 'MATRIX_MATCH');
  assert.deepEqual(row.details, details);
  assert.equal(normalizeQuestionBankRow({ id: 'y', type: 'multiple_correct' }).type, 'MULTIPLE_CORRECT');
  assert.equal(normalizeQuestionBankRow({ id: 'z', type: 'NAT' }).details, null);
});

test('offline recovery and submission keep multiple-correct answers as strings', async () => {
  const { buildSubmissionResponses, mergeOfflineResponses } = await import('../src/examLogic.js');
  const paper = { subjects: ['Physics'], questions: { Physics: [{ id: 'm', type: 'MULTIPLE_CORRECT' }, { id: 'n', type: 'MULTIPLE_CORRECT' }] } };
  const server = { Physics: [{ selectedOption: null, status: 'NOT_ANSWERED' }, { selectedOption: '1', status: 'ANSWERED' }] };
  const local = { Physics: [{ selectedOption: '0,2', status: 'ANSWERED' }, { selectedOption: null, status: 'NOT_ANSWERED' }] };
  const merged = mergeOfflineResponses(paper, server, local);
  assert.deepEqual(merged.Physics[0], { selectedOption: '0,2', status: 'ANSWERED' });
  assert.deepEqual(merged.Physics[1], { selectedOption: null, status: 'NOT_ANSWERED' }, 'a local clear wins over the older server answer');
  assert.deepEqual(buildSubmissionResponses(paper, merged)[0], { question_id: 'm', selected_option: '0,2', status: 'ANSWERED' });
});

test('the editor validates every new type', async () => {
  const { prepareQuestionDraft } = await import('../src/questionContentLogic.js');
  const base = { docId: 'new', subject: 'Physics', text: 'A question', options: ['A', 'B', 'C', 'D'], optionImageUrls: [null, null, null, null] };
  const errorsFor = (draft, existing = []) => prepareQuestionDraft({ ...base, ...draft }, existing).errors.join(' ');

  assert.equal(errorsFor({ type: 'MULTIPLE_CORRECT', correctAnswer: '0,2' }), '');
  assert.match(errorsFor({ type: 'MULTIPLE_CORRECT', correctAnswer: '' }), /Choose at least one correct option/);
  assert.equal(errorsFor({ type: 'INTEGER', correctAnswer: '-4' }), '');
  assert.match(errorsFor({ type: 'INTEGER', correctAnswer: '4.5' }), /whole-number answer/);
  assert.deepEqual(prepareQuestionDraft({ ...base, type: 'INTEGER', correctAnswer: '4' }).question.options, []);
  assert.match(errorsFor({ type: 'MATRIX_MATCH', correctAnswer: '1' }), /require List-I and List-II/);
  const lists = { matchLists: { left: [' Force ', 'Power'], right: ['Newton', 'Watt'] } };
  const matrix = prepareQuestionDraft({ ...base, type: 'MATRIX_MATCH', correctAnswer: '1', details: lists });
  assert.deepEqual(matrix.errors, []);
  assert.deepEqual(matrix.question.details.matchLists.left, ['Force', 'Power']);
  assert.equal(errorsFor({ type: 'ASSERTION_REASON', correctAnswer: '3' }), '');
  assert.match(errorsFor({ type: '', correctAnswer: '0' }), /supported question type/);
  assert.equal(prepareQuestionDraft({ ...base, type: 'MCQ', correctAnswer: '0' }).question.details, null);

  const stem = { type: 'MATRIX_MATCH', correctAnswer: '1', text: 'Match the lists' };
  const bank = [{ id: 'b1', text: 'Match the lists', details: { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } } }];
  assert.equal(errorsFor({ ...stem, details: lists }, bank), '');
  assert.match(errorsFor({ ...stem, details: { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } } }, bank), /matching question already exists/);
});

test('preflight accepts the new types and reports their problems', async () => {
  const { validateExamPreflight } = await import('../src/examPreflightLogic.js');
  const options = ['A', 'B', 'C', 'D'];
  const exam = (questions, extra = {}) => ({
    title: 'Paper',
    class: '12',
    section: 'A',
    questions_data: { duration: 60, marksCorrect: 4, marksIncorrect: -1, subjects: ['Physics'], questions: { Physics: questions }, ...extra }
  });
  const good = validateExamPreflight(exam([
    { id: 'm', type: 'MULTIPLE_CORRECT', text: 'Q', options, correctAnswer: '0,1' },
    { id: 'i', type: 'INTEGER', text: 'Q', options: [], correctAnswer: '12' },
    { id: 'x', type: 'MATRIX_MATCH', text: 'Q', options, correctAnswer: '2', details: { matchLists: { left: ['a', 'b'], right: ['c', 'd'] } } },
    { id: 'a', type: 'ASSERTION_REASON', text: 'Q', options, correctAnswer: 'D' }
  ], { marking: { MULTIPLE_CORRECT: { correct: 4, incorrect: -2, partial: true } } }), { knownSubjects: ['Physics'] });
  assert.deepEqual(good.errors, []);

  const bad = validateExamPreflight(exam([
    { id: 'm', type: 'MULTIPLE_CORRECT', text: 'Q', options, correctAnswer: '2,0' },
    { id: 'i', type: 'INTEGER', text: 'Q', options: [], correctAnswer: '1.5' },
    { id: 'x', type: 'MATRIX_MATCH', text: 'Q', options, correctAnswer: '2' },
    { id: 'e', type: 'ESSAY', text: 'Q', options: [], correctAnswer: '1' }
  ], { marking: { MCQ: { partial: true } } }), { knownSubjects: ['Physics'] });
  const errors = bad.errors.join('\n');
  assert.match(errors, /Multiple correct question has invalid correct answer "2,0"/);
  assert.match(errors, /Integer question has invalid answer "1.5"/);
  assert.match(errors, /Matrix match questions require List-I and List-II/);
  assert.match(errors, /Unsupported question type "ESSAY"/);
  assert.match(errors, /only be set for multiple-correct/);
});

test('exam settings and patterns validate per-type marking', async () => {
  const { validateExamSettings, validatePatternDraft } = await import('../src/examPatternLogic.js');
  assert.deepEqual(validateExamSettings({ duration: 60, marksCorrect: 4, marksIncorrect: -1, marking: { INTEGER: { correct: 4, incorrect: 0 } } }), []);
  assert.match(validateExamSettings({ duration: 60, marksCorrect: 4, marksIncorrect: -1, marking: { INTEGER: { incorrect: 2 } } }).join(' '), /Integer: marks for a wrong answer/);
  const draft = { name: 'P', description: '', durationMinutes: 60, marksCorrect: 4, marksIncorrect: -1, sections: [{ subject: 'Physics', questionCount: 1 }] };
  const subjects = [{ name: 'Physics', isActive: true }];
  assert.deepEqual(validatePatternDraft({ ...draft, marking: { MCQ: { correct: 3 } } }, subjects).errors, []);
  assert.match(validatePatternDraft({ ...draft, marking: { MCQ: { correct: 0 } } }, subjects).errors.join(' '), /Single correct: marks for a correct answer/);
});
