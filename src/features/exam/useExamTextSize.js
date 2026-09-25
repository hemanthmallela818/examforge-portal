// Candidate-controlled question text size (U11).
//
// The chosen level is applied as a CSS custom property on the exam content
// container, so changing it re-renders only ActiveExamView and the navbar
// control; the memoized QuestionPanel/GridPanel scale through CSS alone.
// The preference is per student and per browser (localStorage, fail-safe).
import { useCallback, useState } from 'react';
import { safeStorageGet, safeStorageSet } from '../../browserStorage';

/** @typedef {'small' | 'default' | 'large'} ExamTextSize */

/** @type {ReadonlyArray<{ value: ExamTextSize, label: string, name: string, scale: number }>} */
export const EXAM_TEXT_SIZES = Object.freeze([
  { value: 'small', label: 'A−', name: 'Smaller text', scale: 0.9 },
  { value: 'default', label: 'A', name: 'Default text size', scale: 1 },
  { value: 'large', label: 'A+', name: 'Larger text', scale: 1.25 }
]);

export const DEFAULT_EXAM_TEXT_SIZE = /** @type {ExamTextSize} */ ('default');

/** @param {string | null | undefined} studentId */
export const examTextSizeStorageKey = (studentId) => `examforge_exam_text_size:${studentId || 'anonymous'}`;

/**
 * @param {unknown} value
 * @returns {ExamTextSize}
 */
export const normalizeExamTextSize = (value) => (
  EXAM_TEXT_SIZES.some(size => size.value === value) ? /** @type {ExamTextSize} */ (value) : DEFAULT_EXAM_TEXT_SIZE
);

/** @param {ExamTextSize} value */
export const examTextScale = (value) => EXAM_TEXT_SIZES.find(size => size.value === value)?.scale ?? 1;

/**
 * @param {string | null | undefined} studentId
 * @returns {{ textSize: ExamTextSize, setTextSize: (value: ExamTextSize) => void, textScale: number }}
 */
export function useExamTextSize(studentId) {
  const key = examTextSizeStorageKey(studentId);
  const [state, setState] = useState(() => ({ key, value: normalizeExamTextSize(safeStorageGet('localStorage', key)) }));
  // A different candidate on the same device reads their own preference.
  const textSize = state.key === key ? state.value : normalizeExamTextSize(safeStorageGet('localStorage', key));

  const setTextSize = useCallback((/** @type {ExamTextSize} */ value) => {
    const next = normalizeExamTextSize(value);
    safeStorageSet('localStorage', key, next);
    setState({ key, value: next });
  }, [key]);

  return { textSize, setTextSize, textScale: examTextScale(textSize) };
}
