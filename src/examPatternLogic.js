/**
 * F1 exam patterns: compare the questions an administrator selected with the
 * subject sections required by a pattern, and order exam subjects.
 */

/**
 * @import {
 *   PatternDraft, PatternSelectionResult, PatternSelectionRow, PatternTemplate, SubjectConfig
 * } from './types'
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
const key = value => String(value ?? '').trim().toLowerCase();

/**
 * Count selected question subjects: { Physics: 3, Chemistry: 1 }.
 * @param {Iterable<unknown>} subjects
 * @returns {Record<string, number>}
 */
export function countBySubject(subjects) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const subject of subjects) {
    const name = String(subject ?? '').trim() || 'Unknown';
    counts[name] = (counts[name] || 0) + 1;
  }
  return counts;
}

/**
 * Compare selected counts with a pattern.
 * Returns { ok, rows: [{ subject, required, selected, status }], extras: [{ subject, selected }], problems: string[] }.
 * status is 'ok' | 'short' | 'over'.
 * @param {PatternTemplate | null | undefined} template
 * @param {Record<string, number | string> | null | undefined} countsBySubject
 * @returns {PatternSelectionResult}
 */
export function evaluatePatternSelection(template, countsBySubject) {
  const counts = countsBySubject || {};
  /** @param {string} subject */
  const countFor = subject => Object.entries(counts)
    .filter(([name]) => key(name) === key(subject))
    .reduce((sum, [, value]) => sum + Number(value || 0), 0);

  const sections = Array.isArray(template?.sections) ? template.sections : [];
  /** @type {PatternSelectionRow[]} */
  const rows = sections.map(section => {
    const required = Number(section.questionCount) || 0;
    const selected = countFor(section.subject);
    const status = selected === required ? 'ok' : selected < required ? 'short' : 'over';
    return { subject: section.subject, required, selected, status };
  });

  const patternSubjects = new Set(sections.map(section => key(section.subject)));
  const extras = Object.entries(counts)
    .filter(([name, value]) => Number(value) > 0 && !patternSubjects.has(key(name)))
    .map(([subject, selected]) => ({ subject, selected: Number(selected) }));

  /** @type {string[]} */
  const problems = [];
  rows.forEach(row => {
    if (row.status === 'short') problems.push(`${row.subject}: select ${row.required - row.selected} more (${row.selected}/${row.required}).`);
    if (row.status === 'over') problems.push(`${row.subject}: remove ${row.selected - row.required} (${row.selected}/${row.required}).`);
  });
  extras.forEach(extra => problems.push(`${extra.subject} is not part of this pattern: remove ${extra.selected} question(s).`));

  return { ok: rows.length > 0 && problems.length === 0, rows, extras, problems };
}

/**
 * Order the subjects of a new exam: pattern order when a pattern is used,
 * otherwise the configured subject order (compare function), then by name.
 * @param {string[]} subjects May contain case-variant duplicates; the last spelling wins.
 * @param {PatternTemplate | null | undefined} template
 * @param {((a: string, b: string) => number) | null} [compare]
 * @returns {string[]}
 */
export function orderExamSubjects(subjects, template, compare) {
  const unique = [...new Map(subjects.map(subject => [key(subject), subject])).values()];
  if (Array.isArray(template?.sections) && template.sections.length > 0) {
    const position = new Map(template.sections.map((section, index) => [key(section.subject), index]));
    return unique.sort((a, b) => (position.get(key(a)) ?? Number.MAX_SAFE_INTEGER) - (position.get(key(b)) ?? Number.MAX_SAFE_INTEGER)
      || String(a).localeCompare(String(b)));
  }
  return typeof compare === 'function' ? unique.sort(compare) : unique.sort((a, b) => String(a).localeCompare(String(b)));
}

/**
 * Validate exam settings that the create-exam form edits directly.
 * @param {{ duration: unknown, marksCorrect: unknown, marksIncorrect: unknown }} settings
 * @returns {string[]} Problems; empty when valid.
 */
export function validateExamSettings({ duration, marksCorrect, marksIncorrect }) {
  /** @type {string[]} */
  const problems = [];
  const d = Number(duration);
  if (!Number.isInteger(d) || d < 1 || d > 600) problems.push('Duration must be a whole number between 1 and 600 minutes.');
  const c = Number(marksCorrect);
  if (!Number.isFinite(c) || c <= 0 || c > 100 || Math.round(c * 100) !== c * 100) {
    problems.push('Marks for a correct answer must be greater than 0 and at most 100 (two decimals at most).');
  }
  const i = Number(marksIncorrect);
  if (!Number.isFinite(i) || i < -100 || i > 0 || Math.round(i * 100) !== i * 100) {
    problems.push('Marks for a wrong answer must be between -100 and 0 (two decimals at most).');
  }
  return problems;
}

export const MAX_PATTERN_QUESTIONS = 500;
export const MAX_PATTERN_SECTIONS = 20;
/** @param {number} value */
const hasTwoDecimals = value => Math.round(value * 100) === value * 100;

/**
 * Client-side mirror of the server rules, so problems show before saving.
 * @param {PatternDraft} draft
 * @param {SubjectConfig[]} subjects All configured subjects (active and inactive).
 * @returns {{ errors: string[], total: number, name: string }}
 */
export const validatePatternDraft = (draft, subjects) => {
  /** @type {string[]} */
  const errors = [];
  const name = draft.name.trim().replace(/\s+/g, ' ');
  if (!name) errors.push('Enter a pattern name.');
  if (name.length > 80) errors.push('Pattern name can be at most 80 characters.');
  if (draft.description.trim().length > 500) errors.push('Description can be at most 500 characters.');

  const duration = Number(draft.durationMinutes);
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) errors.push('Duration must be a whole number between 1 and 600 minutes.');
  const correct = Number(draft.marksCorrect);
  if (!Number.isFinite(correct) || correct <= 0 || correct > 100 || !hasTwoDecimals(correct)) {
    errors.push('Marks for a correct answer must be greater than 0 and at most 100 (two decimals at most).');
  }
  const incorrect = Number(draft.marksIncorrect);
  if (!Number.isFinite(incorrect) || incorrect < -100 || incorrect > 0 || !hasTwoDecimals(incorrect)) {
    errors.push('Marks for a wrong answer must be between -100 and 0 (two decimals at most).');
  }

  if (draft.sections.length === 0) errors.push('Add at least one subject section.');
  if (draft.sections.length > MAX_PATTERN_SECTIONS) errors.push(`A pattern can have at most ${MAX_PATTERN_SECTIONS} subject sections.`);
  /** @type {Set<string>} */
  const seen = new Set();
  let total = 0;
  draft.sections.forEach((section, index) => {
    const label = section.subject || `Section ${index + 1}`;
    if (!section.subject) {
      errors.push(`Choose a subject for section ${index + 1}.`);
    } else {
      const known = subjects.find(subject => subject.name.toLowerCase() === section.subject.toLowerCase());
      if (!known) errors.push(`Subject "${section.subject}" no longer exists.`);
      else if (!known.isActive) errors.push(`Subject "${known.name}" is inactive. Remove it or reactivate it first.`);
      if (seen.has(section.subject.toLowerCase())) errors.push(`Subject "${section.subject}" appears more than once.`);
      seen.add(section.subject.toLowerCase());
    }
    const count = Number(section.questionCount);
    if (!Number.isInteger(count) || count < 1 || count > MAX_PATTERN_QUESTIONS) {
      errors.push(`Question count for ${label} must be a whole number between 1 and ${MAX_PATTERN_QUESTIONS}.`);
    } else {
      total += count;
    }
  });
  if (total > MAX_PATTERN_QUESTIONS) errors.push(`A pattern can contain at most ${MAX_PATTERN_QUESTIONS} questions in total (this one has ${total}).`);
  return { errors, total, name };
};

