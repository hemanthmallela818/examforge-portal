import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const { default: StudentAnswerReviewModal } = await import('../../../src/features/admin/exams/StudentAnswerReviewModal');

const paper = {
  subjects: ['Physics'],
  questions: {
    Physics: [
      { id: 'q-multi', type: 'MULTIPLE_CORRECT', text: 'Which are vectors?', options: ['Force', 'Mass', 'Velocity', 'Time'] },
      { id: 'q-int', type: 'INTEGER', text: 'How many legs?', options: [] },
      { id: 'q-mcq', type: 'MCQ', text: 'Unit of power?', options: ['Joule', 'Watt', 'Newton', 'Volt'] }
    ]
  }
};
const answerKey = {
  'q-multi': { correct_answer: '0,2', type: 'MULTIPLE_CORRECT' },
  'q-int': { correct_answer: '4', type: 'INTEGER' },
  'q-mcq': { correct_answer: '1', type: 'MCQ' }
};

const renderModal = (review) => render(
  <StudentAnswerReviewModal
    review={{ studentName: 'Asha', student_id: 'S-1', paper, answer_key: answerKey, subject_time_seconds: { Physics: 125 }, ...review }}
    onClose={vi.fn()}
  />
);

describe('StudentAnswerReviewModal', () => {
  it('pairs answers by question ID and shows the graded outcome and marks', () => {
    renderModal({
      snapshot_format: 'by_question_id',
      // Stored in the shuffled order the student saw; pairing must use the ID.
      responses: {
        'q-mcq': { question_id: 'q-mcq', selected_option: 1, status: 'ANSWERED' },
        'q-int': { question_id: 'q-int', selected_option: '5', status: 'ANSWERED' },
        'q-multi': { question_id: 'q-multi', selected_option: '0', status: 'ANSWERED' }
      },
      question_scores: {
        'q-multi': { outcome: 'PARTIAL', marks: 2 },
        'q-int': { outcome: 'INCORRECT', marks: 0 },
        'q-mcq': { outcome: 'CORRECT', marks: 4 }
      }
    });
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(3);
    const [multi, integer, mcq] = articles;
    expect(within(multi).getByText('Partially correct')).toBeTruthy();
    expect(within(multi).getByText('+2')).toBeTruthy();
    expect(multi.textContent).toContain('Student answer: A. Force');
    expect(multi.textContent).toContain('Correct answer: A. Force; C. Velocity');
    expect(within(integer).getByText('Wrong')).toBeTruthy();
    expect(integer.textContent).toContain('Student answer: 5');
    expect(integer.textContent).toContain('Correct answer: 4');
    expect(within(mcq).getByText('Correct')).toBeTruthy();
    expect(mcq.textContent).toContain('Student answer: B. Watt');
    expect(mcq.textContent).not.toContain('Correct answer:');
  });

  it('withholds the per-question view for older positional snapshots', () => {
    renderModal({ snapshot_format: 'legacy_position', responses: { Physics: [{ selectedOption: 1, status: 'ANSWERED' }] } });
    expect(screen.getByText(/Per-question review is unavailable for attempts submitted before this update/)).toBeTruthy();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText(/2m 5s/)).toBeTruthy();
  });
});
