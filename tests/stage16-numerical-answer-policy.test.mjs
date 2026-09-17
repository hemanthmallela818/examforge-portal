import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUTHOR_NUMERICAL_MAX_LENGTH,
  CANDIDATE_NUMERICAL_MAX_LENGTH,
  NUMERICAL_ABSOLUTE_TOLERANCE,
  isPotentialNumericalAnswer,
  isValidNumericalAnswer,
  validateNumericalAnswer
} from '../src/numericalAnswerPolicy.js';
import { prepareQuestionDraft } from '../src/questionContentLogic.js';
import { validateImportQuestions } from '../src/importLogic.js';

test('candidate numerical policy accepts supported decimal forms', () => {
  for (const value of ['0', '-0', '+5', '5.', '.5', '-.5', '+.25', '000.010', '-3.1415926']) {
    assert.equal(isValidNumericalAnswer(value), true, value);
  }
  assert.equal(NUMERICAL_ABSOLUTE_TOLERANCE, 0.00001);
});

test('candidate numerical policy rejects ambiguous and non-decimal forms', () => {
  for (const value of ['1e3', '1E3', 'NaN', 'Infinity', ' 5', '5 ', '1,5', '--1', '++1', '1..2', '0x10']) {
    assert.equal(isValidNumericalAnswer(value), false, value);
    assert.equal(validateNumericalAnswer(value).transient, false, value);
  }
});

test('natural intermediate typing states are transient but never valid answers', () => {
  for (const value of ['', '-', '+', '.', '-.', '+.']) {
    assert.equal(isPotentialNumericalAnswer(value), true, value);
    assert.equal(isValidNumericalAnswer(value), false, value);
    assert.equal(validateNumericalAnswer(value).transient, true, value);
  }
});

test('candidate and author length boundaries match their server contracts', () => {
  const sixtyFourDigits = '1'.repeat(CANDIDATE_NUMERICAL_MAX_LENGTH);
  const sixtyFiveDigits = '1'.repeat(CANDIDATE_NUMERICAL_MAX_LENGTH + 1);
  const oneHundredDigits = '1'.repeat(AUTHOR_NUMERICAL_MAX_LENGTH);
  assert.equal(isValidNumericalAnswer(sixtyFourDigits), true);
  assert.equal(isValidNumericalAnswer(sixtyFiveDigits), false);
  assert.equal(isValidNumericalAnswer(oneHundredDigits, AUTHOR_NUMERICAL_MAX_LENGTH), true);
  assert.equal(isValidNumericalAnswer(`${oneHundredDigits}1`, AUTHOR_NUMERICAL_MAX_LENGTH), false);
});

test('manual authoring and JSON import use the same numerical grammar', () => {
  const base = { subject: 'Mathematics', type: 'NUMERICAL', text: 'Evaluate x', options: [] };
  assert.deepEqual(prepareQuestionDraft({ ...base, correctAnswer: '-.5' }).errors, []);
  assert.ok(prepareQuestionDraft({ ...base, correctAnswer: '5e-1' }).errors.some(error => /valid numerical answer/i.test(error)));

  const [valid] = validateImportQuestions([{ ...base, correct_answer: '+5', has_image_or_diagram: false }]);
  const [invalid] = validateImportQuestions([{ ...base, correct_answer: '5e0', has_image_or_diagram: false }]);
  assert.equal(valid.approved, true);
  assert.equal(invalid.approved, false);
  assert.ok(invalid.rowErrors.some(error => error.code === 'ROW_INVALID_NUMERICAL_ANSWER'));
});

test('candidate UI keeps invalid drafts out of saved state and blocks actions', () => {
  const panel = readFileSync(resolve('src/components/QuestionPanel.jsx'), 'utf8');
  assert.match(panel, /type="text"/);
  assert.match(panel, /maxLength=\{CANDIDATE_NUMERICAL_MAX_LENGTH\}/);
  assert.match(panel, /if \(validation\.valid\) setSelectedOption\(next\)/);
  assert.match(panel, /else if \(validation\.empty\) setSelectedOption\(null\)/);
  assert.match(panel, /unfinished edit does not replace your last valid saved answer/);
  assert.match(panel, /aria-invalid=\{Boolean\(numericalError\)\}/);
  assert.match(panel, /if \(numericalDraftIsReady\(\)\) handleAction\(action\)/);
  assert.match(panel, /if \(numericalDraftIsReady\(\)\) submitExam\(\)/);
  assert.match(panel, /Scientific notation and spaces are not accepted/);
});
