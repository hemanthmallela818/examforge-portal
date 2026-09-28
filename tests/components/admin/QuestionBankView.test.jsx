import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../src/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('../../../src/utils', () => ({ showToast: vi.fn(), customAlert: vi.fn(), customConfirm: vi.fn() }));

const { AdminContext } = await import('../../../src/features/admin/adminContext');
const { default: QuestionBankView } = await import('../../../src/features/admin/questions/QuestionBankView');

const passage = { key: '00000000-0000-4000-8000-00000000cafe', text: 'A ball is thrown vertically upwards.' };
const questions = [
  { docId: 'q1', id: 'q1', subject: 'Physics', type: 'MULTIPLE_CORRECT', questionNumber: 1, text: 'Which are true?', options: ['A1', 'B1', 'C1', 'D1'], correctAnswer: '0,2', questionImageUrl: null, optionImageUrls: null, hasImageOrDiagram: false, details: { passage }, createdAt: '' },
  { docId: 'q2', id: 'q2', subject: 'Physics', type: 'MATRIX_MATCH', questionNumber: 2, text: 'Match the lists', options: ['m1', 'm2', 'm3', 'm4'], correctAnswer: '1', questionImageUrl: null, optionImageUrls: null, hasImageOrDiagram: false, details: { matchLists: { left: ['Force', 'Power'], right: ['Newton', 'Watt'] } }, createdAt: '' }
];

const makeState = () => ({
  questionBank: questions,
  knownQuestionSubjects: {},
  fetchQuestionBank: vi.fn(),
  editingQuestion: null,
  setEditingQuestion: vi.fn(),
  selectedQuestions: [],
  setSelectedQuestions: vi.fn(),
  questionSearchInput: '',
  setQuestionSearchInput: vi.fn(),
  questionSearch: '',
  setQuestionSearch: vi.fn(),
  questionSubjectFilter: '',
  setQuestionSubjectFilter: vi.fn(),
  questionTypeFilter: '',
  setQuestionTypeFilter: vi.fn(),
  questionBankPage: 0,
  setQuestionBankPage: vi.fn(),
  questionBankTotal: questions.length,
  questionBankSnapshot: { page: 0, search: '', subject: '', type: '' },
  handleSaveQuestion: vi.fn(),
  handleDeleteQuestion: vi.fn(),
  handleAddBlankQuestion: vi.fn(),
  handleNewParagraphSet: vi.fn(),
  handleAddQuestionToPassage: vi.fn(),
  handleUpdatePassage: vi.fn().mockResolvedValue(true)
});

const examBuilder = {
  newExamTitle: '', setNewExamTitle: vi.fn(), isCreatingExam: false,
  examDuration: 180, setExamDuration: vi.fn(), examMarksCorrect: 4, setExamMarksCorrect: vi.fn(),
  examMarksIncorrect: -1, setExamMarksIncorrect: vi.fn(), examMarking: {}, setExamMarking: vi.fn(),
  examTargetClass: '', setExamTargetClass: vi.fn(), examTargetSection: '', setExamTargetSection: vi.fn(),
  selectedTemplateId: '', selectedTemplate: null, usableTemplates: [], selectTemplate: vi.fn(), handleCreateExamFromSelected: vi.fn()
};

const contextValue = {
  dataLoadState: {},
  isRootDeveloper: false,
  classBook: { classes: [] },
  catalog: {
    subjectCatalog: [{ id: 's1', name: 'Physics', isActive: true }],
    activeSubjectNames: ['Physics'],
    allSubjectNames: ['Physics'],
    compareSubjects: (a, b) => String(a).localeCompare(String(b)),
    usableTemplates: []
  }
};

let user;
beforeEach(() => { user = userEvent.setup({ delay: null }); });

const renderView = (state = makeState()) => {
  render(
    <AdminContext.Provider value={contextValue}>
      <QuestionBankView questionBankState={state} examBuilder={examBuilder} onDeleteAllQuestions={vi.fn()} />
    </AdminContext.Provider>
  );
  return state;
};

describe('QuestionBankView new question types', { timeout: 20_000 }, () => {
  it('creates a question of the chosen type or a new paragraph set', async () => {
    const state = renderView();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Type of the new question' }), 'INTEGER');
    await user.click(screen.getByRole('button', { name: /Create question/ }));
    expect(state.handleAddBlankQuestion).toHaveBeenCalledWith('INTEGER');
    await user.click(screen.getByRole('button', { name: /New paragraph set/ }));
    expect(state.handleNewParagraphSet).toHaveBeenCalledTimes(1);
  });

  it('filters by every question type', () => {
    renderView();
    const filter = screen.getByRole('combobox', { name: 'Filter questions by type' });
    expect([...filter.options].map(option => option.value)).toEqual(['', 'MCQ', 'MULTIPLE_CORRECT', 'INTEGER', 'NUMERICAL', 'MATRIX_MATCH', 'ASSERTION_REASON']);
  });

  it('shows each type, its answers, match lists and paragraph actions', async () => {
    const state = renderView();
    const badge = (label) => screen.getAllByText(label).filter(element => element.tagName !== 'OPTION');
    expect(badge('Multiple correct')).toHaveLength(1);
    expect(badge('Matrix match')).toHaveLength(1);
    expect(screen.getByRole('table', { name: 'List-I and List-II' }).textContent).toContain('Q.Power');
    expect(screen.getByText('A ball is thrown vertically upwards.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /Add question to this paragraph/ }));
    expect(state.handleAddQuestionToPassage).toHaveBeenCalledWith(questions[0]);

    await user.click(screen.getByRole('button', { name: /Edit paragraph/ }));
    const dialog = screen.getByRole('dialog', { name: 'Edit paragraph' });
    const text = within(dialog).getByRole('textbox', { name: 'Paragraph text' });
    expect(text.value).toBe(passage.text);
    await user.clear(text);
    await user.type(text, 'A stone is dropped from rest.');
    await user.click(within(dialog).getByRole('button', { name: 'Save paragraph' }));
    expect(state.handleUpdatePassage).toHaveBeenCalledWith(passage.key, 'A stone is dropped from rest.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit paragraph' })).toBeNull());
  });
});
