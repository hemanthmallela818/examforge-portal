import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveAllowedSubjects, formatSubjectList, subjectRequirementMessage, validateImportQuestions } from '../src/importLogic.js';
import { prepareQuestionDraft } from '../src/questionContentLogic.js';
import { countBySubject, evaluatePatternSelection, orderExamSubjects, validateExamSettings, validatePatternDraft } from '../src/examPatternLogic.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('default subjects keep the historic message; configured lists are cleaned', () => {
  assert.equal(subjectRequirementMessage(), 'Subject must be Physics, Chemistry, or Mathematics.');
  assert.deepEqual(resolveAllowedSubjects([' Biology ', 'biology', '', 'Physics']), ['Biology', 'Physics']);
  assert.deepEqual(resolveAllowedSubjects([]), ['Physics', 'Chemistry', 'Mathematics']);
  assert.equal(formatSubjectList(['Biology']), 'Biology');
  assert.equal(formatSubjectList(['Biology', 'Physics']), 'Biology or Physics');
});

test('question drafts and imports accept configured subjects case-insensitively', () => {
  const draft = { subject: 'Biology', type: 'MCQ', text: 'Which organelle makes ATP?', options: ['A', 'B', 'C', 'D'], correctAnswer: 0 };
  assert.ok(prepareQuestionDraft(draft, []).errors.some(e => e.startsWith('Subject must be')));
  assert.deepEqual(prepareQuestionDraft(draft, [], { allowedSubjects: ['Physics', 'Biology'] }).errors, []);

  const row = {
    id: 'bio-1', question_number: 1, question_text: 'Cell membranes are made mainly of?', question_type: 'MCQ',
    options: [{ label: 'A', text: 'Lipids' }, { label: 'B', text: 'Salt' }, { label: 'C', text: 'Iron' }, { label: 'D', text: 'Gold' }],
    correct_answer: 'A', subject: 'biology', has_image_or_diagram: false
  };
  const [rejected] = validateImportQuestions([row], [], { strictSource: true });
  assert.equal(rejected.status, 'WARNING');
  const [accepted] = validateImportQuestions([row], [], { strictSource: true, allowedSubjects: ['Biology'] });
  assert.equal(accepted.status, 'VALID');
  assert.equal(accepted.subject, 'Biology');
});

test('pattern selection check reports shortfalls, excess and foreign subjects', () => {
  const neet = { sections: [{ subject: 'Physics', questionCount: 2 }, { subject: 'Biology', questionCount: 1 }] };
  const exact = evaluatePatternSelection(neet, countBySubject(['Physics', 'physics', 'Biology']));
  assert.ok(exact.ok);
  const short = evaluatePatternSelection(neet, countBySubject(['Physics']));
  assert.ok(!short.ok);
  assert.deepEqual(short.rows.map(r => r.status), ['short', 'short']);
  const foreign = evaluatePatternSelection(neet, countBySubject(['Physics', 'Physics', 'Biology', 'Chemistry']));
  assert.ok(!foreign.ok);
  assert.match(foreign.problems.join(' '), /Chemistry is not part of this pattern/);
  assert.ok(!evaluatePatternSelection({ sections: [] }, {}).ok);
});

test('exam subjects follow the pattern order, else the configured order', () => {
  const pattern = { sections: [{ subject: 'Biology' }, { subject: 'Physics' }] };
  assert.deepEqual(orderExamSubjects(['Physics', 'Biology', 'Physics'], pattern), ['Biology', 'Physics']);
  const order = ['Chemistry', 'Physics'];
  assert.deepEqual(orderExamSubjects(['Physics', 'Chemistry'], null, (a, b) => order.indexOf(a) - order.indexOf(b)), ['Chemistry', 'Physics']);
});

test('exam settings and pattern drafts mirror the server rules', () => {
  assert.deepEqual(validateExamSettings({ duration: 200, marksCorrect: 4, marksIncorrect: -1 }), []);
  assert.equal(validateExamSettings({ duration: 0, marksCorrect: 0, marksIncorrect: 1 }).length, 3);
  assert.equal(validateExamSettings({ duration: 60.5, marksCorrect: 4.125, marksIncorrect: -1 }).length, 2);

  const subjects = [{ name: 'Physics', isActive: true }, { name: 'Biology', isActive: true }, { name: 'Latin', isActive: false }];
  const base = { name: 'NEET Mock', description: '', durationMinutes: 200, marksCorrect: 4, marksIncorrect: -1, isActive: true };
  assert.deepEqual(validatePatternDraft({ ...base, sections: [{ subject: 'Physics', questionCount: 45 }, { subject: 'Biology', questionCount: 90 }] }, subjects).errors, []);
  const bad = validatePatternDraft({ ...base, name: ' ', sections: [
    { subject: 'Physics', questionCount: 0 }, { subject: 'physics', questionCount: 5 }, { subject: 'Latin', questionCount: 5 }, { subject: 'Astrology', questionCount: 5 }
  ] }, subjects).errors.join(' | ');
  for (const expected of ['Enter a pattern name', 'between 1 and 500', 'appears more than once', 'inactive', 'no longer exists']) {
    assert.ok(bad.includes(expected), expected);
  }
  assert.match(validatePatternDraft({ ...base, sections: [{ subject: 'Physics', questionCount: 300 }, { subject: 'Biology', questionCount: 300 }] }, subjects).errors.join(), /at most 500 questions in total/);
});

test('migration replaces every hard-coded subject check with the subjects table', async () => {
  const sql = await read('supabase/migrations/20260924140000_configurable_subjects_and_exam_patterns.sql');
  assert.doesNotMatch(sql, /NOT IN \('Physics', 'Chemistry', 'Mathematics'\)/);
  assert.doesNotMatch(sql, /WHEN 'physics' THEN/);
  assert.match(sql, /CREATE UNIQUE INDEX subjects_name_ci_key ON public\.subjects \(lower\(name\)\)/);
  assert.match(sql, /REVOKE ALL ON public\.subjects, public\.exam_templates FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /so it cannot be renamed/);
  assert.match(sql, /so it cannot be deleted\. Deactivate it instead/);
  assert.match(sql, /used by % active pattern\(s\)/);
  assert.match(sql, /A pattern can contain at most 500 questions in total/);
  assert.match(sql, /IF NOT public\.is_admin_aal2\(\) THEN RAISE EXCEPTION 'Administrator access is required'/);
  for (const action of ['CREATE_SUBJECT', 'UPDATE_SUBJECT', 'DELETE_SUBJECT', 'REORDER_SUBJECTS', 'DELETE_EXAM_TEMPLATE']) {
    assert.match(sql, new RegExp(`'${action}'`), action);
  }
  assert.match(sql, /IF TG_OP = 'INSERT' OR NEW\.subject IS DISTINCT FROM OLD\.subject THEN/);
});
