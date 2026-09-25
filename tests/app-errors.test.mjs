import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_ERROR, classifyAppError, isAppError } from '../src/appErrors.js';

test('SQLSTATE codes win over wording', () => {
  assert.equal(classifyAppError({ code: 'EX001', message: 'anything' }), APP_ERROR.SESSION_REPLACED);
  assert.equal(classifyAppError({ code: 'EX003', message: '' }), APP_ERROR.ACCOUNT_INACTIVE);
  assert.equal(classifyAppError({ code: '42501', message: 'Root developer access is required' }), APP_ERROR.FORBIDDEN);
  const exam = { EX005: 'ALREADY_SUBMITTED', EX006: 'NOT_ASSIGNED', EX007: 'EXAM_UNAVAILABLE', EX008: 'TIME_EXPIRED',
    EX009: 'SESSION_NOT_STARTED', EX010: 'ANSWER_KEY_MISSING', EX011: 'SESSION_NOT_FOUND', EX012: 'VALIDATION_FAILED' };
  for (const [code, expected] of Object.entries(exam)) assert.equal(classifyAppError({ code, message: '' }), expected, code);
});

test('Edge Function application codes are honoured', () => {
  assert.equal(classifyAppError({ appCode: 'CONFLICT', message: 'Reactivate this student first' }), APP_ERROR.CONFLICT);
  assert.equal(classifyAppError({ code: 'VALIDATION_FAILED', error: 'Bad input' }), APP_ERROR.VALIDATION_FAILED);
});

test('legacy wording still maps for older servers', () => {
  const cases = [
    ['This student session has been replaced or is no longer active', APP_ERROR.SESSION_REPLACED],
    ['This exam has already been submitted', APP_ERROR.ALREADY_SUBMITTED],
    ['Active session not found or already submitted', APP_ERROR.SESSION_NOT_FOUND],
    ['This exam is not assigned to you', APP_ERROR.NOT_ASSIGNED],
    ['This exam is not available for submission', APP_ERROR.EXAM_UNAVAILABLE],
    ['Exam time has expired; progress was not saved', APP_ERROR.TIME_EXPIRED],
    ['Exam session was not started correctly', APP_ERROR.SESSION_NOT_STARTED],
    ['This student account is inactive', APP_ERROR.ACCOUNT_INACTIVE],
    ['The result set changed while exporting', APP_ERROR.RESULT_SET_CHANGED]
  ];
  for (const [message, expected] of cases) assert.equal(classifyAppError({ message }), expected, message);
});

test('HTTP status is the fallback and unknowns stay unknown', () => {
  assert.equal(classifyAppError({ status: 429 }), APP_ERROR.RATE_LIMITED);
  assert.equal(classifyAppError({ httpStatus: 503 }), APP_ERROR.UNAVAILABLE);
  assert.equal(classifyAppError({ message: 'Something odd' }), APP_ERROR.UNKNOWN);
  assert.equal(classifyAppError(null), APP_ERROR.UNKNOWN);
  assert.ok(isAppError({ code: 'EX001' }, APP_ERROR.SESSION_REPLACED));
});
