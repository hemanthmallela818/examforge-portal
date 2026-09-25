import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../src/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../../src/utils', () => ({ showToast: vi.fn(), customAlert: vi.fn(), customConfirm: vi.fn() }));

const { supabase } = await import('../../../src/supabase');
const { customAlert, customConfirm, showToast } = await import('../../../src/utils');
const { AdminContext } = await import('../../../src/features/admin/adminContext');
const { default: StandaloneExamWizard } = await import('../../../src/features/admin/wizard/StandaloneExamWizard');
const { summarizeSelection, validateDetailsStep, validateQuestionsStep, buildReviewChecks } = await import('../../../src/features/admin/wizard/wizardLogic');

const pattern = {
  id: 't1', name: 'Mini JEE', description: '', durationMinutes: 90, marksCorrect: 3, marksIncorrect: -2, isActive: true,
  totalQuestions: 3, inactiveSubjects: [], sections: [{ subject: 'Physics', questionCount: 2 }, { subject: 'Chemistry', questionCount: 1 }]
};

const rows = [
  { id: 'q1', question_number: 1, subject: 'Physics', type: 'MCQ', question_text: 'Unit of force?', options: ['Joule', 'Newton', 'Watt', 'Pascal'], correct_answer: '1', question_image_url: null, option_image_urls: null, has_image_or_diagram: false },
  { id: 'q2', question_number: 2, subject: 'Chemistry', type: 'MCQ', question_text: 'Symbol of sodium?', options: ['Na', 'S', 'So', 'N'], correct_answer: '0', question_image_url: null, option_image_urls: null, has_image_or_diagram: false },
  { id: 'q3', question_number: 3, subject: 'Physics', type: 'NUMERICAL', question_text: 'Half of 5?', options: [], correct_answer: '2.5', question_image_url: null, option_image_urls: null, has_image_or_diagram: false }
];

const insert = vi.fn();
const contextValue = {
  classBook: { classes: [{ id: 'c1', name: '12', sections: ['A', 'B'] }], fetchClasses: vi.fn() },
  loadedCollections: { current: new Set(['classes']) },
  dataLoadState: {},
  catalog: {
    subjectCatalog: [{ id: 's1', name: 'Physics', isActive: true }, { id: 's2', name: 'Chemistry', isActive: true }],
    allSubjectNames: ['Physics', 'Chemistry'],
    activeSubjectNames: ['Physics', 'Chemistry'],
    compareSubjects: (a, b) => ['Physics', 'Chemistry'].indexOf(a) - ['Physics', 'Chemistry'].indexOf(b),
    usableTemplates: [pattern]
  }
};

let user;
beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(customAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(customConfirm).mockReset().mockResolvedValue(true);
  vi.mocked(showToast).mockReset();
  insert.mockReset().mockResolvedValue({ error: null });
  vi.mocked(supabase.from).mockReset().mockReturnValue({ insert });
  vi.mocked(supabase.rpc).mockReset().mockImplementation(async (name, args) => {
    if (name === 'get_admin_question_bank_page') {
      return { data: { page: args.page_number_param, page_size: args.page_size_param, total: rows.length, rows }, error: null };
    }
    if (name === 'get_admin_questions_by_ids') {
      const selected = args.question_ids_param.map(id => rows.find(row => row.id === id));
      return { data: { requested_count: selected.length, rows: selected }, error: null };
    }
    return { data: null, error: new Error(`unexpected rpc ${name}`) };
  });
});

const renderWizard = () => {
  const handlers = { onClose: vi.fn(), onExamCreated: vi.fn() };
  render(<AdminContext.Provider value={contextValue}><StandaloneExamWizard {...handlers} /></AdminContext.Provider>);
  return handlers;
};

const dialog = () => screen.getByRole('dialog', { name: 'Create exam' });
const stepButton = (label) => within(screen.getByRole('navigation', { name: 'Exam creation steps' })).getByRole('button', { name: new RegExp(label) });
const next = () => within(dialog()).getByRole('button', { name: /^Next:/ });

async function completeDetails() {
  await user.type(screen.getByLabelText('Exam title'), 'Unit Test 1');
  await user.selectOptions(screen.getByLabelText('Class'), '12');
  await user.click(next());
  await screen.findByText('Showing 1-3 of 3 questions.');
}

describe('wizardLogic', () => {
  it('validates details and question selection', () => {
    expect(validateDetailsStep({ title: ' ', targetClass: '', targetSection: '' })).toEqual({
      title: 'Enter an exam title.', targetClass: 'Choose the class that will write this exam.'
    });
    expect(validateDetailsStep({ title: 'x'.repeat(201), targetClass: '12', targetSection: '' })).toMatchObject({ targetSection: 'Choose a section.' });
    expect(validateDetailsStep({ title: 'Ok', targetClass: '12', targetSection: 'A' })).toEqual({});
    expect(validateQuestionsStep({ selectedCount: 0, patternCheck: null })).toEqual(['Select at least one question.']);
    expect(validateQuestionsStep({ selectedCount: 501, patternCheck: null })[0]).toMatch(/at most 500/);
  });

  it('summarizes live per-subject counts and marks, with the pattern first', () => {
    const summary = summarizeSelection({ selectedIds: ['q1', 'q3', 'x'], subjectsById: { q1: 'Physics', q3: 'Physics', x: 'Biology' }, marksCorrect: 3, template: pattern });
    expect(summary.rows).toEqual([
      { subject: 'Physics', count: 2, required: 2, status: 'ok', marks: 6 },
      { subject: 'Chemistry', count: 0, required: 1, status: 'short', marks: 0 },
      { subject: 'Biology', count: 1, required: null, status: 'extra', marks: 3 }
    ]);
    expect(summary.totalMarks).toBe(9);
    expect(summary.patternCheck.ok).toBe(false);
  });

  it('review checks fail while the questions are unverified or incomplete', () => {
    const base = { details: { title: 'T', targetClass: '12', targetSection: 'A' }, settings: { duration: 60, marksCorrect: 4, marksIncorrect: -1 }, template: null, record: null, knownSubjects: ['Physics'] };
    expect(buildReviewChecks({ ...base, verifiedQuestions: null }).ready).toBe(false);
    const broken = [{ docId: 'q1', id: 'q1', subject: 'Physics', type: 'MCQ', text: '', options: ['a', 'b', 'c', 'd'], correctAnswer: '0', questionImageUrl: null, optionImageUrls: null, hasImageOrDiagram: false }];
    const { checks, ready } = buildReviewChecks({ ...base, verifiedQuestions: broken });
    expect(ready).toBe(false);
    expect(checks.find(check => check.id === 'complete').ok).toBe(false);
  });
});

describe('ExamCreationWizard', () => {
  it('labels the steps, blocks later steps and shows field errors until details are valid', async () => {
    renderWizard();
    expect(stepButton('Details').getAttribute('aria-current')).toBe('step');
    expect(stepButton('Questions').disabled).toBe(true);
    expect(stepButton('Review').disabled).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Exam title')));

    await user.click(next());
    expect(screen.getByText('Enter an exam title.')).toBeTruthy();
    expect(screen.getByText('Choose the class that will write this exam.')).toBeTruthy();
    expect(screen.getByLabelText('Exam title').getAttribute('aria-invalid')).toBe('true');
    expect(stepButton('Details').getAttribute('aria-current')).toBe('step');

    await user.type(screen.getByLabelText('Exam title'), 'Unit Test 1');
    await user.selectOptions(screen.getByLabelText('Class'), '12');
    expect(screen.getByLabelText('Section').value).toBe('A');
    await user.click(next());
    await waitFor(() => expect(document.activeElement.textContent).toContain('Pattern and question selection'));
    expect(stepButton('Questions').getAttribute('aria-current')).toBe('step');
  });

  it('selects questions with live counts and marks and enforces the pattern', async () => {
    renderWizard();
    await completeDetails();
    await user.click(next());
    expect(screen.getByRole('alert').textContent).toContain('Select at least one question.');

    await user.click(screen.getByRole('checkbox', { name: /Include question 1:/ }));
    const summary = () => screen.getByRole('table', { name: 'Selected questions and marks by subject' });
    expect(within(summary()).getByRole('rowheader', { name: 'Physics' }).parentElement.textContent).toBe('Physics14');

    await user.selectOptions(screen.getByLabelText('Exam pattern'), 't1');
    expect(within(summary()).getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
    await user.click(next());
    expect(screen.getByRole('alert').textContent).toContain('Physics: select 1 more (1/2).');

    await user.click(screen.getByLabelText('Select all on this page (3)'));
    expect(screen.getByText('Matches')).toBeTruthy();
    expect(within(summary()).getByRole('rowheader', { name: 'Total' }).parentElement.textContent).toBe('Total3 / 39');
    await user.click(next());
    expect(stepButton('Marking').getAttribute('aria-current')).toBe('step');
  });

  it('locks marking to the pattern, validates custom marking and creates the exam through the normal path', async () => {
    const { onExamCreated, onClose } = renderWizard();
    await completeDetails();
    await user.click(screen.getByLabelText('Select all on this page (3)'));

    // Custom: marking is editable and validated.
    await user.click(next());
    const duration = screen.getByLabelText('Duration (minutes)');
    expect(duration.disabled).toBe(false);
    await user.clear(duration);
    await user.type(duration, '0');
    expect(screen.getByRole('alert').textContent).toContain('Duration must be a whole number between 1 and 600 minutes.');
    expect(stepButton('Review').disabled).toBe(true);

    // Pattern: values are pre-filled and locked.
    await user.click(stepButton('Questions'));
    await screen.findByText('Showing 1-3 of 3 questions.');
    await user.selectOptions(screen.getByLabelText('Exam pattern'), 't1');
    await user.click(next());
    expect(screen.getByLabelText('Duration (minutes)').value).toBe('90');
    expect(screen.getByLabelText('Duration (minutes)').disabled).toBe(true);
    expect(screen.getByLabelText('Marks for a correct answer').value).toBe('3');
    expect(screen.getByText('Set by the "Mini JEE" pattern')).toBeTruthy();

    await user.click(next());
    await screen.findByText('Ready to create');
    expect(supabase.rpc).toHaveBeenCalledWith('get_admin_questions_by_ids', { question_ids_param: ['q1', 'q2', 'q3'] });
    expect(screen.getByText('Matches the "Mini JEE" pattern')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Preview as student' }));
    const preview = screen.getByRole('region', { name: 'Student view (read-only)' });
    expect(within(preview).getByText('Unit of force?')).toBeTruthy();
    expect(within(preview).getAllByRole('radio').every(radio => radio.disabled)).toBe(true);
    await user.click(within(preview).getByRole('button', { name: 'Next question' }));
    expect(within(preview).getByText('Half of 5?')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Create exam' }));
    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    const saved = insert.mock.calls[0][0];
    expect(saved).toMatchObject({ title: 'Unit Test 1', status: 'PENDING', class: '12', section: 'A' });
    expect(saved.questions_data).toMatchObject({
      subjects: ['Physics', 'Chemistry'], totalQuestions: 3, duration: 90, marksCorrect: 3, marksIncorrect: -2, pattern: { id: 't1', name: 'Mini JEE' }
    });
    expect(saved.questions_data.questions.Physics.map(q => q.id)).toEqual(['q1', 'q3']);
    expect(onExamCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Exam created successfully!', 'success');
  });

  it('asks before discarding a draft', async () => {
    const { onClose } = renderWizard();
    await user.type(screen.getByLabelText('Exam title'), 'Draft');
    vi.mocked(customConfirm).mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Close exam creation' }));
    expect(customConfirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
