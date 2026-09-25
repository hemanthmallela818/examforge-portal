import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../src/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));

const { default: LiveOverviewPanel } = await import('../../../src/features/admin/overview/LiveOverviewPanel');
const { normalizeLiveOverview, describeLiveTiming, notStartedCount, formatMinutes, formatScore } = await import('../../../src/features/admin/overview/liveOverviewLogic');

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const minutesAhead = (minutes) => new Date(Date.now() + minutes * 60000).toISOString();

const payload = {
  checked_at: new Date().toISOString(),
  students_writing: 4,
  awaiting_finalization: 1,
  live_exams: [{
    id: 'exam-1', title: 'Physics Unit Test', class: '12', section: 'A', activated_at: minutesAgo(25),
    duration: 90, total_questions: 30, writing: 4, awaiting_finalization: 1, latest_deadline_at: minutesAhead(60),
    submitted: 10, assigned_students: 20
  }],
  recent_results: [{
    id: 'r1', exam_id: 'exam-1', exam_title: 'Physics Unit Test', student_id: 'S001', student_name: 'Asha Rao',
    total_score: 42, max_score: 60, submitted_at: minutesAgo(5)
  }]
};

const renderPanel = (overrides = {}) => {
  const handlers = { onOpenExam: vi.fn(), onCreateExam: vi.fn(), onGoToQuestionBank: vi.fn() };
  const live = { overview: normalizeLiveOverview(payload), loading: false, error: '', fetchLiveOverview: vi.fn(), ...overrides };
  render(<LiveOverviewPanel live={live} {...handlers} />);
  return { ...handlers, live };
};

describe('liveOverviewLogic', () => {
  it('normalizes the RPC payload and rejects invalid shapes', () => {
    const overview = normalizeLiveOverview(payload);
    expect(overview.studentsWriting).toBe(4);
    expect(overview.liveExams[0]).toMatchObject({ id: 'exam-1', writing: 4, submitted: 10, assignedStudents: 20, awaitingFinalization: 1 });
    expect(overview.recentResults[0]).toMatchObject({ examId: 'exam-1', studentName: 'Asha Rao', totalScore: 42 });
    expect(() => normalizeLiveOverview(null)).toThrow();
    expect(() => normalizeLiveOverview({ live_exams: {} , recent_results: [] })).toThrow();
    expect(normalizeLiveOverview({ live_exams: [{ id: 1 }], recent_results: [], students_writing: -3 }).liveExams).toEqual([]);
  });

  it('describes timing and counts', () => {
    const exam = normalizeLiveOverview(payload).liveExams[0];
    const { liveFor, endsBy } = describeLiveTiming(exam);
    expect(liveFor).toMatch(/^Live since .+ \(25 min\)$/);
    expect(endsBy).toMatch(/^Current attempts end by /);
    expect(describeLiveTiming({ ...exam, writing: 0 }).endsBy).toBe('');
    expect(notStartedCount(exam)).toBe(5);
    expect(formatMinutes(135)).toBe('2 h 15 min');
    expect(formatScore(null, 60)).toBe('— / 60');
  });
});

describe('LiveOverviewPanel', () => {
  it('shows each live exam with writing, submitted and timing info, and opens it on click', async () => {
    const user = userEvent.setup({ delay: null });
    const { onOpenExam } = renderPanel();
    const card = screen.getByRole('button', { name: 'Physics Unit Test' });
    expect(within(card).getByText('writing now').previousSibling.textContent).toBe('4');
    expect(within(card).getByText('submitted').previousSibling.textContent).toBe('10');
    expect(within(card).getByText('not started').previousSibling.textContent).toBe('5');
    expect(within(card).getByText(/12 \| Section A/)).toBeTruthy();
    expect(within(card).getByText(/1 expired attempt\(s\) awaiting finalization/)).toBeTruthy();
    expect(within(card).getByText(/90 min paper · 30 Qs/)).toBeTruthy();
    await user.click(card);
    expect(onOpenExam).toHaveBeenCalledWith('exam-1');
  });

  it('shows students writing now, awaiting finalization and recent results', async () => {
    const user = userEvent.setup({ delay: null });
    const { onOpenExam } = renderPanel();
    const rightNow = screen.getByRole('region', { name: 'Right now' });
    expect(within(rightNow).getByText('Students writing now').nextSibling.textContent).toBe('4');
    expect(within(rightNow).getByText('Awaiting finalization').nextSibling.textContent).toBe('1');
    const results = screen.getByRole('list', { name: 'Recent results' });
    expect(within(results).getByText('Asha Rao')).toBeTruthy();
    expect(within(results).getByText('42 / 60')).toBeTruthy();
    expect(within(results).getByText('5 min ago')).toBeTruthy();
    await user.click(within(results).getByRole('button'));
    expect(onOpenExam).toHaveBeenCalledWith('exam-1');
  });

  it('offers quick actions and an empty state when nothing is live', async () => {
    const user = userEvent.setup({ delay: null });
    const empty = normalizeLiveOverview({ ...payload, live_exams: [], recent_results: [], students_writing: 0, awaiting_finalization: 0 });
    const { onCreateExam, onGoToQuestionBank } = renderPanel({ overview: empty });
    expect(screen.getByText('No exams are live')).toBeTruthy();
    expect(screen.getByText('No results have been submitted yet.')).toBeTruthy();
    expect(screen.getByText('No expired attempts are waiting.')).toBeTruthy();
    const actions = screen.getByRole('region', { name: 'Quick actions' });
    await user.click(within(actions).getByRole('button', { name: 'Create exam' }));
    await user.click(within(actions).getByRole('button', { name: 'Open Question Bank' }));
    expect(onCreateExam).toHaveBeenCalledTimes(1);
    expect(onGoToQuestionBank).toHaveBeenCalledTimes(1);
  });

  it('reports a load error with Retry', async () => {
    const user = userEvent.setup({ delay: null });
    const { live } = renderPanel({ overview: null, error: 'Live exam activity could not be loaded.' });
    expect(screen.getByRole('alert').textContent).toContain('Live exam activity could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(live.fetchLiveOverview).toHaveBeenCalled();
  });
});
