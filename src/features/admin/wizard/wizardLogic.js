/**
 * Pure rules for the step-by-step exam creation wizard: step list, per-step
 * validation, the live per-subject selection summary and the Review checks.
 */
import { countBySubject, evaluatePatternSelection, validateExamSettings } from '../../../examPatternLogic';
import { validateExamPreflight } from '../../../examPreflightLogic';
import { prepareQuestionDraft } from '../../../questionContentLogic';
import { MAX_EXAM_QUESTIONS } from '../adminConstants';

/** @typedef {'details' | 'questions' | 'marking' | 'review'} WizardStepId */

/** @type {ReadonlyArray<{ id: WizardStepId, label: string, description: string }>} */
export const WIZARD_STEPS = Object.freeze([
  { id: 'details', label: 'Details', description: 'Title, class and section' },
  { id: 'questions', label: 'Questions', description: 'Pattern and question selection' },
  { id: 'marking', label: 'Marking & timing', description: 'Duration and marks' },
  { id: 'review', label: 'Review', description: 'Checks and student preview' }
]);

export const MAX_EXAM_TITLE_LENGTH = 200;

/**
 * @param {{ title: string, targetClass: string, targetSection: string }} details
 * @returns {{ title?: string, targetClass?: string, targetSection?: string }} Field errors; empty when valid.
 */
export function validateDetailsStep({ title, targetClass, targetSection }) {
  /** @type {{ title?: string, targetClass?: string, targetSection?: string }} */
  const errors = {};
  const trimmed = String(title || '').trim();
  if (!trimmed) errors.title = 'Enter an exam title.';
  else if (trimmed.length > MAX_EXAM_TITLE_LENGTH) errors.title = `The title can be at most ${MAX_EXAM_TITLE_LENGTH} characters.`;
  if (!targetClass) errors.targetClass = 'Choose the class that will write this exam.';
  if (targetClass && !targetSection) errors.targetSection = 'Choose a section.';
  return errors;
}

/**
 * @param {{ selectedCount: number, patternCheck: import('../../../types').PatternSelectionResult | null }} input
 * @returns {string[]} Problems; empty when the selection can be used.
 */
export function validateQuestionsStep({ selectedCount, patternCheck }) {
  if (selectedCount === 0) return ['Select at least one question.'];
  if (selectedCount > MAX_EXAM_QUESTIONS) {
    return [`An exam can contain at most ${MAX_EXAM_QUESTIONS} questions. Remove ${selectedCount - MAX_EXAM_QUESTIONS}.`];
  }
  if (patternCheck && !patternCheck.ok) return patternCheck.problems;
  return [];
}

/**
 * @param {{ duration: unknown, marksCorrect: unknown, marksIncorrect: unknown }} settings
 * @returns {string[]}
 */
export function validateMarkingStep(settings) {
  return validateExamSettings(settings);
}

/**
 * Live per-subject counts and marks for the current selection. Pattern
 * sections come first (in pattern order, with their required count), then any
 * other selected subjects in the configured subject order.
 * @param {{
 *   selectedIds: string[],
 *   subjectsById: Record<string, string>,
 *   marksCorrect: unknown,
 *   template: import('../../../types').PatternTemplate | null,
 *   compareSubjects?: ((a: string, b: string) => number) | null
 * }} input
 */
export function summarizeSelection({ selectedIds, subjectsById, marksCorrect, template, compareSubjects }) {
  const counts = countBySubject(selectedIds.map(id => subjectsById[id]));
  const perQuestion = Number(marksCorrect);
  const marksFor = (/** @type {number} */ questions) => (Number.isFinite(perQuestion) ? questions * perQuestion : null);
  const patternCheck = template ? evaluatePatternSelection(template, counts) : null;
  /** @type {Array<{ subject: string, count: number, required: number | null, status: 'ok' | 'short' | 'over' | 'extra' | null, marks: number | null }>} */
  const rows = [];
  if (patternCheck) {
    patternCheck.rows.forEach(row => rows.push({ subject: row.subject, count: row.selected, required: row.required, status: row.status, marks: marksFor(row.selected) }));
    patternCheck.extras.forEach(extra => rows.push({ subject: extra.subject, count: extra.selected, required: null, status: 'extra', marks: marksFor(extra.selected) }));
  } else {
    const subjects = Object.keys(counts);
    subjects.sort(typeof compareSubjects === 'function' ? compareSubjects : (a, b) => a.localeCompare(b));
    subjects.forEach(subject => rows.push({ subject, count: counts[subject], required: null, status: null, marks: marksFor(counts[subject]) }));
  }
  return {
    rows,
    patternCheck,
    totalQuestions: selectedIds.length,
    totalMarks: marksFor(selectedIds.length)
  };
}

/**
 * @typedef {object} ReviewCheck
 * @property {string} id
 * @property {string} label
 * @property {boolean} ok
 * @property {string[]} [details]
 * @property {string[]} [warnings]
 */

/**
 * Preflight-style checks run on the Review step against the server-verified
 * questions and the exact record the Create action will insert.
 * @param {{
 *   details: { title: string, targetClass: string, targetSection: string },
 *   settings: { duration: unknown, marksCorrect: unknown, marksIncorrect: unknown },
 *   template: import('../../../types').PatternTemplate | null,
 *   verifiedQuestions: import('../../../types').QuestionBankItem[] | null,
 *   verificationError?: string,
 *   record: import('../../../types').UntrustedInput | null,
 *   knownSubjects: string[]
 * }} input
 * @returns {{ checks: ReviewCheck[], ready: boolean }}
 */
export function buildReviewChecks({ details, settings, template, verifiedQuestions, verificationError = '', record, knownSubjects }) {
  /** @type {ReviewCheck[]} */
  const checks = [];
  const detailErrors = Object.values(validateDetailsStep(details));
  checks.push({ id: 'details', label: 'Title, class and section are set', ok: detailErrors.length === 0, details: detailErrors });

  const settingsProblems = validateMarkingStep(settings);
  checks.push({ id: 'marking', label: 'Marking and timing are valid', ok: settingsProblems.length === 0, details: settingsProblems });

  checks.push({
    id: 'verified',
    label: 'Selected questions verified on the server',
    ok: Boolean(verifiedQuestions) && !verificationError,
    details: verificationError ? [verificationError] : verifiedQuestions ? [] : ['Checking the selected questions…']
  });

  if (verifiedQuestions) {
    const incomplete = verifiedQuestions
      .map((question, index) => ({ number: index + 1, errors: prepareQuestionDraft(question, verifiedQuestions, { allowedSubjects: knownSubjects }).errors }))
      .filter(result => result.errors.length > 0)
      .map(result => `Question ${result.number}: ${result.errors.join(' ')}`);
    checks.push({ id: 'complete', label: 'Every selected question is complete', ok: incomplete.length === 0, details: incomplete.slice(0, 5) });

    if (template) {
      const patternCheck = evaluatePatternSelection(template, countBySubject(verifiedQuestions.map(question => question.subject)));
      checks.push({ id: 'pattern', label: `Matches the "${template.name}" pattern`, ok: patternCheck.ok, details: patternCheck.problems });
    }

    if (record) {
      const preflight = validateExamPreflight(record, { knownSubjects });
      checks.push({ id: 'preflight', label: 'Paper passes the preflight check', ok: preflight.valid, details: preflight.errors.slice(0, 5), warnings: preflight.warnings.slice(0, 5) });
    }
  }

  const ready = Boolean(verifiedQuestions) && checks.every(check => check.ok);
  return { checks, ready };
}
