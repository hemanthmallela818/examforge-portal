import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../src/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../../src/utils', () => ({ showToast: vi.fn(), customAlert: vi.fn() }));

const { supabase } = await import('../../../src/supabase');
const { customAlert, showToast } = await import('../../../src/utils');
const { AdminContext } = await import('../../../src/features/admin/adminContext');
const { useExamBuilder } = await import('../../../src/features/admin/questions/useExamBuilder');
const { default: CreateExamCard } = await import('../../../src/features/admin/questions/CreateExamCard');

let user;
beforeEach(() => {
  user = userEvent.setup({ delay: null });
  vi.mocked(customAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(showToast).mockReset();
  vi.mocked(supabase.rpc).mockReset();
  vi.mocked(supabase.from).mockReset();
});

const pattern = {
  id: 't1',
  name: 'Mini JEE',
  description: '',
  durationMinutes: 90,
  marksCorrect: 3,
  marksIncorrect: -2,
  isActive: true,
  totalQuestions: 3,
  inactiveSubjects: [],
  sections: [{ subject: 'Physics', questionCount: 2 }, { subject: 'Chemistry', questionCount: 1 }]
};

const classes = [
  { id: 'c1', name: '12', sections: ['A', 'B'] },
  { id: 'c2', name: '11', sections: [] }
];

const subjectsById = { q1: 'Physics', q2: 'Physics', q3: 'Chemistry', q4: 'Physics', q5: 'Biology' };

function Harness({ selectedQuestions, onExamCreated = () => {} }) {
  const examBuilder = useExamBuilder({ selectedQuestions, setSelectedQuestions: () => {}, onExamCreated });
  return <CreateExamCard examBuilder={examBuilder} selectedQuestions={selectedQuestions} knownQuestionSubjects={subjectsById} />;
}

const contextValue = {
  classBook: { classes },
  catalog: {
    allSubjectNames: ['Physics', 'Chemistry', 'Biology'],
    compareSubjects: (a, b) => String(a).localeCompare(String(b)),
    usableTemplates: [pattern]
  }
};

const renderCard = (selectedQuestions = []) => {
  const view = render(
    <AdminContext.Provider value={contextValue}><Harness selectedQuestions={selectedQuestions} /></AdminContext.Provider>
  );
  const rerenderWith = (ids) => view.rerender(
    <AdminContext.Provider value={contextValue}><Harness selectedQuestions={ids} /></AdminContext.Provider>
  );
  return { ...view, rerenderWith };
};

const durationInput = () => screen.getByRole('spinbutton', { name: 'Duration for new exam' });
const correctInput = () => screen.getByRole('spinbutton', { name: 'Marks for a correct answer' });
const incorrectInput = () => screen.getByRole('spinbutton', { name: 'Marks for an incorrect answer' });
const patternSelect = () => screen.getByRole('combobox', { name: 'Exam pattern for new exam' });
const createButton = () => screen.getByRole('button', { name: /Create Exam/ });

describe('CreateExamCard', () => {
  it('starts as a custom exam with editable defaults and create disabled without a selection', () => {
    renderCard();
    expect(durationInput().value).toBe('180');
    expect(correctInput().value).toBe('4');
    expect(incorrectInput().value).toBe('-1');
    for (const input of [durationInput(), correctInput(), incorrectInput()]) expect(input.disabled).toBe(false);
    expect(patternSelect().value).toBe('');
    expect(screen.getByRole('option', { name: 'Mini JEE · 3 Qs · 90 min' })).toBeTruthy();
    expect(screen.queryByText('Pattern check')).toBeNull();
    expect(createButton().disabled).toBe(true);
  });

  it('choosing a pattern fills and locks duration and marking; Custom unlocks them', async () => {
    renderCard(['q1']);
    await user.selectOptions(patternSelect(), 't1');
    expect(durationInput().value).toBe('90');
    expect(correctInput().value).toBe('3');
    expect(incorrectInput().value).toBe('-2');
    for (const input of [durationInput(), correctInput(), incorrectInput()]) expect(input.disabled).toBe(true);
    expect(screen.getByText('Duration and marking come from the pattern.')).toBeTruthy();

    await user.selectOptions(patternSelect(), '');
    for (const input of [durationInput(), correctInput(), incorrectInput()]) expect(input.disabled).toBe(false);
    // The values chosen by the pattern stay as a starting point for the custom exam.
    expect(durationInput().value).toBe('90');
  });

  it('shows short / over / extra states and only enables Create when the selection matches', async () => {
    const { rerenderWith } = renderCard(['q1']);
    await user.selectOptions(patternSelect(), 't1');

    // Short: 1/2 Physics, 0/1 Chemistry.
    expect(screen.getByText('Not yet')).toBeTruthy();
    const list = screen.getByRole('list');
    expect(within(list).getByText('1 / 2').className).toContain('amber');
    expect(within(list).getByText('0 / 1').className).toContain('amber');
    expect(screen.getByRole('status').textContent).toBe('Physics: select 1 more (1/2).');
    expect(createButton().disabled).toBe(true);

    // Over plus an extra subject not in the pattern.
    rerenderWith(['q1', 'q2', 'q4', 'q3', 'q5']);
    expect(within(screen.getByRole('list')).getByText('3 / 2').className).toContain('red');
    expect(screen.getByText('Biology (not in pattern)')).toBeTruthy();
    expect(screen.getByText('Not yet')).toBeTruthy();
    expect(createButton().disabled).toBe(true);

    // Exact match.
    rerenderWith(['q1', 'q2', 'q3']);
    expect(screen.getByText('Matches')).toBeTruthy();
    expect(within(screen.getByRole('list')).getByText('2 / 2').className).toContain('emerald');
    expect(screen.queryByRole('status')).toBeNull();
    expect(createButton().disabled).toBe(false);
  });

  it('disables Create and shows the first problem when custom settings are invalid', async () => {
    renderCard(['q1']);
    expect(createButton().disabled).toBe(false);
    await user.clear(durationInput());
    await user.type(durationInput(), '0');
    expect(screen.getByRole('alert').textContent).toContain('Duration must be a whole number between 1 and 600 minutes.');
    expect(createButton().disabled).toBe(true);
  });

  it('fills the section from the chosen class and disables section until a class is chosen', async () => {
    renderCard();
    const section = screen.getByRole('combobox', { name: 'Target section for new exam' });
    expect(section.disabled).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target class for new exam' }), '12');
    expect(section.disabled).toBe(false);
    expect(section.value).toBe('A');
    expect(within(section).getAllByRole('option').map(o => o.textContent)).toEqual(['Select Target Section...', 'A', 'B']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Target class for new exam' }), '11');
    expect(section.value).toBe('');
  });

  it('asks for a title before creating instead of calling the server', async () => {
    renderCard(['q1']);
    await user.click(createButton());
    expect(customAlert).toHaveBeenCalledWith('Please enter an Exam Title first.');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
