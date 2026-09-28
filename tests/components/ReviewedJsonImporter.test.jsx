import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../src/supabase', () => {
  const history = { select: () => history, order: () => history, limit: () => Promise.resolve({ data: [], error: null }) };
  return { supabase: { from: vi.fn(() => history), rpc: vi.fn() } };
});
vi.mock('../../src/utils', () => ({ customAlert: vi.fn(), customConfirm: vi.fn(), showToast: vi.fn() }));

const { default: ReviewedJsonImporter } = await import('../../src/components/AIQuestionImporter');

const OPTIONS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const row = (overrides) => ({
  question_text: `Question ${Math.random()}`, question_type: 'MCQ', options: OPTIONS, correct_answer: 'A',
  subject: 'Physics', has_image_or_diagram: false, ...overrides
});

async function upload(questions) {
  const { container } = render(<ReviewedJsonImporter questionBank={[]} refreshQuestionBank={vi.fn()} allowedSubjects={['Physics']} />);
  const file = new File([JSON.stringify({ version: '1.0', questions })], 'paper.json', { type: 'application/json' });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
  await waitFor(() => expect(screen.getAllByRole('article').length).toBe(questions.length));
  return screen.getAllByRole('article');
}

describe('Reviewed JSON importer: new question types', () => {
  it('reviews multiple-correct, matrix-match and paragraph rows', async () => {
    const [multi, matrix, para] = await upload([
      row({ question_number: 1, question_type: 'MULTIPLE_CORRECT', correct_answer: 'A,C' }),
      row({ question_number: 2, question_type: 'MATRIX_MATCH', correct_answer: 'B', match_lists: { list_i: ['Force', 'Power'], list_ii: ['Newton', 'Watt'] } }),
      row({ question_number: 3, question_type: 'INTEGER', options: [], correct_answer: '7', passage: { key: 'P1', text: 'A ball is thrown upwards.' } })
    ]);

    expect(within(multi).getByRole('combobox', { name: 'Question type for row 1' }).value).toBe('MULTIPLE_CORRECT');
    expect(within(multi).getByRole('checkbox', { name: 'Option A is correct for row 1' }).checked).toBe(true);
    expect(within(multi).getByRole('checkbox', { name: 'Option B is correct for row 1' }).checked).toBe(false);
    expect(within(multi).getByRole('checkbox', { name: 'Option C is correct for row 1' }).checked).toBe(true);
    expect(within(multi).queryByRole('alert')).toBeNull();

    expect(within(matrix).getByRole('table', { name: 'List-I and List-II' }).textContent).toContain('Q.Power');
    expect(within(matrix).getByLabelText('List-II (one item per line)').value).toBe('Newton\nWatt');

    expect(within(para).getByLabelText('Paragraph (P1)').value).toBe('A ball is thrown upwards.');
    expect(within(para).getByPlaceholderText('Correct whole number...').value).toBe('7');
  });

  it('switching a row to matrix match asks for its lists', async () => {
    const [single] = await upload([row({ question_number: 1 })]);
    fireEvent.change(within(single).getByRole('combobox', { name: 'Question type for row 1' }), { target: { value: 'MATRIX_MATCH' } });
    const article = screen.getAllByRole('article')[0];
    await waitFor(() => expect(within(article).getByRole('alert').textContent).toContain('Every List-I and List-II item needs 1 to 2000 characters'));
  });
});
