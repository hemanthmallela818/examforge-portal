export const CANDIDATE_NUMERICAL_MAX_LENGTH = 64;
export const AUTHOR_NUMERICAL_MAX_LENGTH = 100;
export const NUMERICAL_ABSOLUTE_TOLERANCE = 0.00001;

const COMPLETE_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const POTENTIAL_DECIMAL = /^[+-]?(?:\d*(?:\.\d*)?)?$/;

/** @import { NumericalValidation } from './types' */

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {NumericalValidation}
 */
export function validateNumericalAnswer(value, maxLength = CANDIDATE_NUMERICAL_MAX_LENGTH) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text === '') return { valid: false, empty: true, transient: true, text, error: '' };
  if (text.length > maxLength) {
    return { valid: false, empty: false, transient: false, text, error: `Use at most ${maxLength} characters.` };
  }
  if (COMPLETE_DECIMAL.test(text)) {
    return { valid: true, empty: false, transient: false, text, error: '' };
  }
  if (POTENTIAL_DECIMAL.test(text)) {
    return { valid: false, empty: false, transient: true, text, error: 'Finish entering the numerical value.' };
  }
  return {
    valid: false,
    empty: false,
    transient: false,
    text,
    error: 'Use decimal notation only, for example -3.14 or 0.5. Scientific notation is not accepted.'
  };
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {boolean}
 */
export function isValidNumericalAnswer(value, maxLength = CANDIDATE_NUMERICAL_MAX_LENGTH) {
  return validateNumericalAnswer(value, maxLength).valid;
}

/**
 * True for complete values and valid prefixes still being typed.
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {boolean}
 */
export function isPotentialNumericalAnswer(value, maxLength = CANDIDATE_NUMERICAL_MAX_LENGTH) {
  const result = validateNumericalAnswer(value, maxLength);
  return result.valid || result.transient;
}
