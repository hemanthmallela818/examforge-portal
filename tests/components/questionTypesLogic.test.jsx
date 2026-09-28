import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../src/utils', () => ({ showToast: vi.fn(), customAlert: vi.fn(), customConfirm: vi.fn() }));

const { summarizeSelection } = await import('../../src/features/admin/wizard/wizardLogic');
const { assembleExamRecord, compactMarking } = await import('../../src/features/admin/questions/useExamBuilder');
const { shuffleQuestionBlocks, committedResultToScorecard } = await import('../../src/features/exam/examSessionHelpers');

const passage = key => ({ passage: { key, text: `Paragraph ${key}` } });
const question = (id, subject, type = 'MCQ', details = null) => ({ id, docId: id, subject, type, text: id, options: [], correctAnswer: '0', details });

describe('per-type marks in the selection summary', () => {
  it('totals each question at its type marks, falling back to the exam-wide marks', () => {
    const summary = summarizeSelection({
      selectedIds: ['a', 'b', 'c', 'd'],
      subjectsById: { a: 'Physics', b: 'Physics', c: 'Chemistry', d: 'Chemistry' },
      typesById: { a: 'MCQ', b: 'MULTIPLE_CORRECT', c: 'INTEGER', d: 'NAT' },
      marksCorrect: 4,
      marking: { MCQ: { correct: 3 }, NUMERICAL: { correct: 2 } },
      template: null
    });
    expect(summary.totalMarks).toBe(3 + 4 + 4 + 2);
    expect(summary.rows.map(row => [row.subject, row.marks])).toEqual([['Chemistry', 6], ['Physics', 7]]);
  });

  it('keeps the old behaviour without types or marking', () => {
    const summary = summarizeSelection({ selectedIds: ['a', 'b'], subjectsById: { a: 'Physics', b: 'Physics' }, marksCorrect: 4, template: null });
    expect(summary.totalMarks).toBe(8);
  });
});

describe('exam assembly', () => {
  it('keeps a paragraph set together and stores only the per-type marks that were set', () => {
    const record = assembleExamRecord({
      title: 'Paper', targetClass: '12', targetSection: 'A', duration: 180, marksCorrect: 4, marksIncorrect: -1,
      marking: { MCQ: { correct: 3, incorrect: -1 }, INTEGER: { correct: '', incorrect: undefined }, MULTIPLE_CORRECT: { partial: false } },
      template: null,
      questions: [
        question('p1', 'Physics', 'MCQ', passage('k1')),
        question('x', 'Physics'),
        question('p2', 'Physics', 'INTEGER', passage('k1')),
        question('y', 'Physics')
      ],
      compareSubjects: null
    });
    expect(record.questions_data.questions.Physics.map(q => q.id)).toEqual(['p1', 'p2', 'x', 'y']);
    expect(record.questions_data.marking).toEqual({ MCQ: { correct: 3, incorrect: -1 }, MULTIPLE_CORRECT: { partial: false } });
  });

  it('omits marking when nothing is set', () => {
    expect(compactMarking({ MCQ: {}, INTEGER: { correct: '' } })).toBeUndefined();
    const record = assembleExamRecord({
      title: 'Paper', targetClass: '12', targetSection: 'A', duration: 60, marksCorrect: 4, marksIncorrect: -1,
      template: null, questions: [question('a', 'Physics')], compareSubjects: null
    });
    expect('marking' in record.questions_data).toBe(false);
  });
});

describe('fallback shuffle', () => {
  it('never splits or reorders a paragraph set', () => {
    const questions = [question('a', 'P'), question('p1', 'P', 'MCQ', passage('k')), question('p2', 'P', 'MCQ', passage('k')), question('p3', 'P', 'MCQ', passage('k')), question('b', 'P'), question('c', 'P')];
    for (let i = 0; i < 50; i += 1) {
      const ids = shuffleQuestionBlocks(questions).map(q => q.id);
      expect([...ids].sort()).toEqual(['a', 'b', 'c', 'p1', 'p2', 'p3']);
      const start = ids.indexOf('p1');
      expect(ids.slice(start, start + 3)).toEqual(['p1', 'p2', 'p3']);
    }
  });
});

describe('committed scorecards', () => {
  it('carry the partial count, defaulting to 0 for older rows', () => {
    expect(committedResultToScorecard({ total_score: 5, max_score: 8, correct: 1, partial: 1, incorrect: 0, unattempted: 0, subject_scores: {} }).partial).toBe(1);
    expect(committedResultToScorecard({ total_score: 4, max_score: 8, correct: 1, incorrect: 0, unattempted: 1, subject_scores: {} }).partial).toBe(0);
  });
});
