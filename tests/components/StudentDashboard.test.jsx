import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const channel = { on: vi.fn(() => channel), subscribe: vi.fn(() => channel) };
vi.mock('../../src/supabase', () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const rows = { results: [], exams: [] };
vi.mock('../../src/paginatedQuery', () => ({
  // The dashboard loads results first, then exams.
  fetchAllRows: vi.fn()
}));

const { fetchAllRows } = await import('../../src/paginatedQuery');
const { default: StudentDashboard } = await import('../../src/components/StudentDashboard');

const student = { id: 'STU-9', docId: 'uuid-9', name: 'Asha Rao', class: '12', section: 'A' };
const paper = { duration: 60, subjects: ['Physics'] };
const exam = (id, title, status, created_at) => ({ id, title, status, class: 'All', section: 'All', created_at, questions_data: paper });

const renderDashboard = async () => {
  vi.mocked(fetchAllRows)
    .mockResolvedValueOnce(rows.results)
    .mockResolvedValueOnce(rows.exams);
  render(<StudentDashboard student={student} onLogout={vi.fn()} onStartExam={vi.fn()} onViewResult={vi.fn()} />);
  await screen.findByRole('region', { name: /Live now/ });
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(fetchAllRows).mockReset();
  rows.exams = [
    exam('live', 'Live Mock', 'ACTIVE', '2026-09-03'),
    exam('pending', 'Pending Mock', 'PENDING', '2026-09-04'),
    exam('done1', 'Done One', 'ENDED', '2026-09-01'),
    exam('done2', 'Done Two', 'ACTIVE', '2026-09-02'),
    exam('ended', 'Closed Mock', 'ENDED', '2026-08-01')
  ];
  rows.results = [
    { exam_id: 'done1', total_score: 30, max_score: 60, correct: 1, incorrect: 0, unattempted: 0, subject_scores: {} },
    { exam_id: 'done2', total_score: 45, max_score: 60, correct: 1, incorrect: 0, unattempted: 0, subject_scores: {} }
  ];
});

describe('StudentDashboard grouping (U13)', () => {
  it('groups exams into Live, Upcoming, Completed and Ended with the expected actions', async () => {
    await renderDashboard();
    const live = screen.getByRole('region', { name: /Live now/ });
    expect(within(live).getByText('Live Mock')).toBeTruthy();
    expect(within(live).getByRole('button', { name: /Start Exam/ })).toBeTruthy();

    const upcoming = screen.getByRole('region', { name: /Upcoming/ });
    expect(within(upcoming).getByText('Pending Mock')).toBeTruthy();
    expect(within(upcoming).getByText(/starts when your administrator opens it/i)).toBeTruthy();
    expect(within(upcoming).queryByRole('button')).toBeNull();

    const completed = screen.getByRole('region', { name: /Completed/ });
    expect(within(completed).getAllByRole('button', { name: /View Scorecard/ })).toHaveLength(2);
    // A submitted exam is Completed even while the exam itself is still ACTIVE.
    expect(within(completed).getByText('Done Two')).toBeTruthy();

    const ended = screen.getByRole('region', { name: /Ended/ });
    expect(within(ended).getByText('This exam has ended.')).toBeTruthy();

    for (const card of document.querySelectorAll('.student-exam-card')) {
      expect(card.className).toBe('student-exam-card');
    }
  });

  it('shows a score trend across completed exams, oldest first', async () => {
    await renderDashboard();
    const chart = screen.getByRole('img', { name: /Score trend across 2 completed exams: 50%, 75%/ });
    expect(chart.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByText('Your score trend')).toBeTruthy();
  });

  it('shows a live countdown for the attempt in progress on this device', async () => {
    localStorage.setItem('cbt_active_exam_session', JSON.stringify({
      studentId: 'STU-9',
      activeExam: { id: 'live' },
      endTime: Date.now() + 90 * 60 * 1000
    }));
    await renderDashboard();
    const live = screen.getByRole('region', { name: /Live now/ });
    expect(within(live).getByRole('button', { name: /Resume Exam/ })).toBeTruthy();
    expect(within(live).getByText(/Time remaining in your attempt/).textContent).toMatch(/1:(29:5\d|30:00)/);
  });

  it('hides the trend when nothing has been completed', async () => {
    rows.results = [];
    await renderDashboard();
    expect(screen.queryByText('Your score trend')).toBeNull();
    expect(screen.queryByRole('region', { name: /Completed/ })).toBeNull();
  });
});

describe('StudentDashboard after a termination', () => {
  it('never offers Start or Resume for an attempt ended on this device before its result arrives', async () => {
    const { savePendingTerminationRecord } = await import('../../src/examLogic');
    savePendingTerminationRecord({ student, examId: 'live', userUuid: student.docId });
    // A stale "in progress" record for the same exam must not bring back Resume.
    localStorage.setItem('cbt_active_exam_session', JSON.stringify({
      studentId: student.id, userUuid: student.docId, activeExam: { id: 'live' }, endTime: Date.now() + 60_000
    }));
    vi.mocked(fetchAllRows)
      .mockResolvedValueOnce(rows.results)
      .mockResolvedValueOnce(rows.exams);
    render(<StudentDashboard student={student} onLogout={vi.fn()} onStartExam={vi.fn()} onViewResult={vi.fn()} />);

    const completed = await screen.findByRole('region', { name: /Completed/ });
    const card = /** @type {HTMLElement} */ (within(completed).getByText('Live Mock').closest('.student-exam-card'));
    expect(within(card).getByText('Ended, result pending')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Start Exam|Resume Exam/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /Live now/ })).toBeNull();
  });
});
