import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  status: { data: { status: 'ACTIVE' }, error: null },
  compat: { compatible: true, missingFeatures: [] },
  realtimeHandler: null
}));

vi.mock('../../src/supabase', () => {
  const query = {
    select: () => query,
    eq: () => query,
    single: () => Promise.resolve(mocks.status)
  };
  const channel = {
    on: (_event, _filter, handler) => { mocks.realtimeHandler = handler; return channel; },
    subscribe: () => channel
  };
  return {
    supabase: {
      from: vi.fn(() => query),
      channel: vi.fn(() => channel),
      removeChannel: vi.fn()
    }
  };
});

vi.mock('../../src/runtimeConfig', () => ({
  checkBrowserCompatibility: () => mocks.compat,
  isNarrowViewport: (width) => width < 768
}));

const { supabase } = await import('../../src/supabase');
const { default: PreExam } = await import('../../src/components/PreExam');

// delay: null keeps typing synchronous-fast while still dispatching full event sequences.
let user;
beforeEach(() => { user = userEvent.setup({ delay: null }); });

const consent = () => screen.getByRole('checkbox', { name: 'I have read and understood the instructions.' });

beforeEach(() => {
  mocks.status = { data: { status: 'ACTIVE' }, error: null };
  mocks.compat = { compatible: true, missingFeatures: [] };
  mocks.realtimeHandler = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PreExam', () => {
  it('shows exam details and sections', async () => {
    render(<PreExam startExam={vi.fn()} activeExamId="exam-1" duration={90} marksCorrect={3} marksIncorrect={-1} subjects={['Physics', 'Biology']} />);
    expect(screen.getByRole('heading', { name: 'Exam Instructions' })).toBeTruthy();
    expect(screen.getByText('90 minutes')).toBeTruthy();
    expect(screen.getByText('+3 marks')).toBeTruthy();
    expect(screen.getByText('-1 mark')).toBeTruthy();
    expect(screen.getByText('The exam sections are: Physics, Biology.')).toBeTruthy();
    await screen.findByRole('button', { name: 'Start Exam' });
    expect(supabase.from).toHaveBeenCalledWith('cbt_exams');
  });

  it('keeps Start disabled until the consent checkbox is ticked', async () => {
    const startExam = vi.fn();
    render(<PreExam startExam={startExam} activeExamId="exam-1" />);
    const start = await screen.findByRole('button', { name: 'Start Exam' });
    expect(start.disabled).toBe(true);
    expect(screen.getByText('Tick the checkbox above to enable the Start button.')).toBeTruthy();

    await user.click(consent());
    expect(start.disabled).toBe(false);
    expect(screen.queryByText('Tick the checkbox above to enable the Start button.')).toBeNull();
    await user.click(start);
    expect(startExam).toHaveBeenCalledTimes(1);

    await user.click(consent());
    expect(start.disabled).toBe(true);
  });

  it('waits for the administrator while the exam is not active, then enables on realtime activation', async () => {
    mocks.status = { data: { status: 'PENDING' }, error: null };
    render(<PreExam startExam={vi.fn()} activeExamId="exam-1" />);
    await user.click(consent());
    const waiting = await screen.findByRole('button', { name: 'Waiting for Admin to Start...' });
    expect(waiting.disabled).toBe(true);

    act(() => mocks.realtimeHandler({ new: { status: 'ACTIVE' } }));
    expect(screen.getByRole('button', { name: 'Start Exam' }).disabled).toBe(false);
  });

  it('never enables Start when the browser compatibility check fails', async () => {
    mocks.compat = { compatible: false, missingFeatures: ['localStorage is blocked, full, or unavailable'] };
    render(<PreExam startExam={vi.fn()} activeExamId="exam-1" />);
    expect(screen.getByRole('alert').textContent).toContain('This browser cannot safely start the exam.');
    expect(screen.getByText('localStorage is blocked, full, or unavailable')).toBeTruthy();
    await user.click(consent());
    const start = screen.getByRole('button', { name: 'Browser Storage Required to Start' });
    expect(start.disabled).toBe(true);
  });

  it('reports a status lookup failure', async () => {
    mocks.status = { data: null, error: new Error('network down') };
    render(<PreExam startExam={vi.fn()} activeExamId="exam-1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to verify the exam status. Check your connection.');
    expect(screen.getByRole('button', { name: 'Waiting for Admin to Start...' }).disabled).toBe(true);
  });

  it('unsubscribes from realtime on unmount', async () => {
    const { unmount } = render(<PreExam startExam={vi.fn()} activeExamId="exam-1" />);
    await screen.findByRole('button', { name: 'Start Exam' });
    unmount();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(1);
  });
});
