import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuestionDraft } from '../src/questionContentLogic.js';

const validDraft = overrides => ({
  docId: 'new', subject: 'Physics', type: 'MCQ', text: 'A complete question',
  options: ['A', 'B', 'C', 'D'], correctAnswer: 0,
  questionImageUrl: null, optionImageUrls: [null, null, null, null],
  ...overrides
});

test('manual question validation normalizes valid MCQ content', () => {
  const result = prepareQuestionDraft(validDraft({ text: '  A complete question  ' }));
  assert.deepEqual(result.errors, []);
  assert.equal(result.question.text, 'A complete question');
  assert.equal(result.question.correctAnswer, '0');
});

test('manual questions enforce JEE subjects, lengths, answers, and complete options', () => {
  const result = prepareQuestionDraft(validDraft({
    subject: 'General', text: 'x'.repeat(10001), options: ['same', ' same ', '', 'D'], correctAnswer: 9
  }));
  const errors = result.errors.join(' ');
  assert.match(errors, /Subject must/);
  assert.match(errors, /10,000/);
  assert.match(errors, /duplicates another option/);
  assert.match(errors, /Option C/);
  assert.match(errors, /valid correct option/);
});

test('image-required questions cannot be saved or assembled without their diagram', () => {
  const missing = prepareQuestionDraft(validDraft({ hasImageOrDiagram: true }));
  assert.match(missing.errors.join(' '), /requiring an image or diagram/);
  const complete = prepareQuestionDraft(validDraft({ hasImageOrDiagram: true, questionImageUrl: 'questions/diagram.jpg' }));
  assert.deepEqual(complete.errors, []);
});

test('image-only prompts and options are supported while duplicate text is canonicalized', () => {
  const imageOnly = prepareQuestionDraft(validDraft({
    text: '', questionImageUrl: 'questions/prompt.jpg',
    options: ['', '', 'C', 'D'], optionImageUrls: ['questions/a.jpg', 'questions/b.jpg', null, null]
  }));
  assert.deepEqual(imageOnly.errors, []);

  const duplicate = prepareQuestionDraft(validDraft({ text: '  VALUE  OF  Ｘ ' }), [{ docId: 'other', text: 'value of X' }]);
  assert.match(duplicate.errors.join(' '), /already exists/);
});

test('switching to numerical content removes stale option text and images and preserves zero', () => {
  const result = prepareQuestionDraft(validDraft({
    type: 'NUMERICAL', correctAnswer: 0, optionImageUrls: ['old.jpg'], options: ['old']
  }));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.question.options, []);
  assert.deepEqual(result.question.optionImageUrls, []);
  assert.equal(result.question.correctAnswer, '0');
});
