import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const channel = { on: vi.fn(() => channel), subscribe: vi.fn(() => channel) };
vi.mock('../../src/supabase', () => ({
  supabase: {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    rpc: vi.fn(),
    from: vi.fn()
  }
}));

const rows = { results: [], exams: [], sessions: [], hasMore: false };
const pageReply = () => ({
  data: { exams: rows.exams.map(exam => ({
    ...exam,
    result: rows.results.find(result => result.exam_id === exam.id) || null,
    session: rows.sessions.find(session => session.exam_id === exam.id) || null
  })), has_more: rows.hasMore, server_now: new Date().toISOString() },
  error: null
});
const rpcReply = reply => ({ abortSignal: vi.fn(() => Promise.resolve(reply)) });
const { supabase } = await import('../../src/supabase');
const { default: StudentDashboard } = await import('../../src/components/StudentDashboard');

const student = { id: 'STU-9', docId: 'uuid-9', name: 'Asha Rao', class: '12', section: 'A' };
const paper = { duration: 60, subjects: ['Physics'] };
const exam = (id, title, status, created_at) => ({ id, title, status, class: 'All', section: 'All', created_at, questions_data: paper });

const renderDashboard = async () => {
  render(<StudentDashboard student={student} onLogout={vi.fn()} onStartExam={vi.fn()} onViewResult={vi.fn()} />);
  await screen.findByRole('region', { name: /Live now/ });
};

beforeEach(() => {
  localStorage.clear();
  rows.sessions = [];
  rows.hasMore = false;
  vi.mocked(supabase.rpc).mockReset().mockImplementation(() => rpcReply(pageReply()));
  vi.mocked(supabase.channel).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(supabase.from).mockReset().mockImplementation(() => { throw new Error('Unexpected historical table query'); });
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
    const chart = screen.getByRole('img', { name: /Score trend across 2 completed exams on this page: 50%, 75%/ });
    expect(chart.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByText('Your score trend')).toBeTruthy();
    expect(screen.getByText(/completed exams on this page/i)).toBeTruthy();
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
    render(<StudentDashboard student={student} onLogout={vi.fn()} onStartExam={vi.fn()} onViewResult={vi.fn()} />);

    const completed = await screen.findByRole('region', { name: /Completed/ });
    const card = /** @type {HTMLElement} */ (within(completed).getByText('Live Mock').closest('.student-exam-card'));
    expect(within(card).getByText('Ended, result pending')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Start Exam|Resume Exam/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /Live now/ })).toBeNull();
  });
});


describe('StudentDashboard server attempt state', () => {
  it('blocks a terminated attempt using the real database fields', async () => {
    rows.sessions = [{ id: 'attempt', exam_id: 'live', status: 'TERMINATED', deadline_at: new Date(Date.now() + 60000).toISOString(), termination_reason: 'escape', access_generation: 2 }];
    await renderDashboard();
    const card = screen.getByText('Live Mock').closest('.student-exam-card');
    expect(within(card).getByText('Blocked')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /Start Exam|Resume Exam/ })).toBeNull();
  });

  it('resumes a server IN_PROGRESS attempt with its original countdown', async () => {
    rows.sessions = [{ id: 'attempt', exam_id: 'live', status: 'IN_PROGRESS', deadline_at: new Date(Date.now() + 90 * 60000).toISOString(), access_generation: 2 }];
    await renderDashboard();
    const card = screen.getByText('Live Mock').closest('.student-exam-card');
    expect(within(card).getByRole('button', { name: /Resume Exam/ })).toBeTruthy();
    expect(within(card).getByText(/Time remaining in your attempt/).textContent).toMatch(/1:(29:5\d|30:00)/);
  });
});


describe('StudentDashboard bounded page reads', () => {
  it('reads one dashboard page without subscribing or loading historical tables', async () => {
    await renderDashboard();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith('student_dashboard_page', { page_param: 0 });
    const query = vi.mocked(supabase.rpc).mock.results[0].value;
    expect(query.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(supabase.channel).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('loads later pages only on demand and refreshes only the displayed page', async () => {
    rows.hasMore = true;
    await renderDashboard();
    expect(screen.getByRole('button', { name: /previous page/i }).disabled).toBe(true);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    rows.exams = [exam('older', 'Older Mock', 'PENDING', '2025-01-01')];
    rows.results = [];
    rows.hasMore = false;
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    await screen.findByText('Older Mock');
    expect(screen.queryByText('Live Mock')).toBeNull();
    expect(screen.queryByText('Your score trend')).toBeNull();
    expect(screen.getByRole('button', { name: /next page/i }).disabled).toBe(true);
    expect(supabase.rpc).toHaveBeenLastCalledWith('student_dashboard_page', { page_param: 1 });
    await act(async () => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(3));
    expect(supabase.rpc).toHaveBeenLastCalledWith('student_dashboard_page', { page_param: 1 });
    fireEvent.click(screen.getByRole('button', { name: /previous page/i }));
    await waitFor(() => expect(supabase.rpc).toHaveBeenLastCalledWith('student_dashboard_page', { page_param: 0 }));
  });

  it('recovers from RPC errors through retry without losing the current page', async () => {
    rows.hasMore = true;
    await renderDashboard();
    vi.mocked(supabase.rpc).mockImplementationOnce(() => rpcReply({ data: null, error: { message: 'network failed' } }));
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    await screen.findByRole('alert');
    rows.exams = [exam('recover', 'Recovered Mock', 'ACTIVE', '2025-01-01')];
    fireEvent.click(screen.getByRole('button', { name: /retry dashboard/i }));
    await screen.findByText('Recovered Mock');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(supabase.rpc).toHaveBeenLastCalledWith('student_dashboard_page', { page_param: 1 });
  });

  it.each([true, false])('routes replaced ownership to the session callback or logout (callback=%s)', async hasCallback => {
    vi.mocked(supabase.rpc).mockImplementation(() => rpcReply({ data: null, error: { code: 'EX001', message: 'replaced' } }));
    const onLogout = vi.fn();
    const onSessionReplaced = hasCallback ? vi.fn() : undefined;
    render(<StudentDashboard student={student} onLogout={onLogout} onSessionReplaced={onSessionReplaced} onStartExam={vi.fn()} />);
    await waitFor(() => expect(onSessionReplaced || onLogout).toHaveBeenCalledTimes(1));
    if (hasCallback) expect(onLogout).not.toHaveBeenCalled();
  });

  it.each([false, true])('ignores an aborted old page reply when the user changes page (ownership error=%s)', async ownershipError => {
    rows.hasMore = true;
    await renderDashboard();
    let resolveOld;
    let oldSignal;
    vi.mocked(supabase.rpc).mockImplementationOnce(() => ({ abortSignal: signal => {
      oldSignal = signal;
      return new Promise(resolve => { resolveOld = resolve; });
    } }));
    await act(async () => window.dispatchEvent(new Event('online')));
    rows.exams = [exam('current', 'Current Page Mock', 'ACTIVE', '2025-01-01')];
    rows.hasMore = false;
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    await screen.findByText('Current Page Mock');
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld(ownershipError
      ? { data: null, error: { code: 'EX001', message: 'replaced' } }
      : { data: { exams: [exam('late', 'Stale Mock', 'ACTIVE', '2024-01-01')], has_more: true }, error: null }));
    expect(screen.queryByText('Stale Mock')).toBeNull();
    expect(screen.getByText('Current Page Mock')).toBeTruthy();
  });

  it('describes local pending answers without promising an offline score', async () => {
    const { savePendingSubmissionRecord } = await import('../../src/examLogic');
    savePendingSubmissionRecord({ student, examId: 'live', userUuid: student.docId, responses: [] });
    await renderDashboard();
    expect(screen.getByText(/only answers confirmed by the server/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry submission/i })).toBeTruthy();
  });
});
