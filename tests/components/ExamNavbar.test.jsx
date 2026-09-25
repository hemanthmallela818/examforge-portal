import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../src/components/LiveAnnouncer', () => ({
  announcePolite: vi.fn(),
  announceAssertive: vi.fn()
}));

const { announceAssertive, announcePolite } = await import('../../src/components/LiveAnnouncer');
const { default: ExamNavbar } = await import('../../src/components/ExamNavbar');

const baseProps = {
  subjects: ['Physics', 'Chemistry', 'Mathematics'],
  activeSubject: 'Chemistry',
  setActiveSubject: vi.fn(),
  studentName: 'Asha Rao',
  examTitle: 'Mock Test 7',
  timeLeft: 3725,
  autosaveStatus: 'SAVED'
};

const renderNavbar = (overrides = {}) => {
  const props = { ...baseProps, setActiveSubject: vi.fn(), ...overrides };
  const view = render(<ExamNavbar {...props} />);
  return { props, ...view };
};

const statusPills = () => screen.getAllByRole('status');

beforeEach(() => {
  vi.mocked(announcePolite).mockClear();
  vi.mocked(announceAssertive).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExamNavbar header', () => {
  it('shows the exam title, candidate and formatted timer', () => {
    renderNavbar();
    expect(screen.getByRole('heading', { name: 'Mock Test 7' })).toBeTruthy();
    expect(screen.getByText('Asha Rao')).toBeTruthy();
    const timer = screen.getByRole('timer');
    expect(timer.textContent).toBe('01:02:05');
    expect(timer.getAttribute('aria-label')).toBe('01:02:05 remaining');
    expect(timer.classList.contains('exam-timer--urgent')).toBe(false);
    expect(screen.getByText('Time Left:')).toBeTruthy();
  });

  it('falls back to a default title', () => {
    renderNavbar({ examTitle: '', studentName: '' });
    expect(screen.getByRole('heading', { name: 'JEE Main CBT Mock Test' })).toBeTruthy();
    expect(screen.queryByText(/Candidate:/)).toBeNull();
  });

  it('marks the timer urgent at or under five minutes, but not while paused', () => {
    const { rerender, props } = renderNavbar({ timeLeft: 301 });
    expect(screen.getByRole('timer').classList.contains('exam-timer--urgent')).toBe(false);
    rerender(<ExamNavbar {...props} timeLeft={300} />);
    expect(screen.getByRole('timer').classList.contains('exam-timer--urgent')).toBe(true);
    expect(screen.getByRole('timer').textContent).toBe('00:05:00');
    rerender(<ExamNavbar {...props} timeLeft={120} paused />);
    expect(screen.getByRole('timer').classList.contains('exam-timer--urgent')).toBe(false);
    expect(screen.getByText('Timer Paused:')).toBeTruthy();
  });

  it('announces timer milestones once as they are crossed', () => {
    const { rerender, props } = renderNavbar({ timeLeft: 305 });
    rerender(<ExamNavbar {...props} timeLeft={300} />);
    rerender(<ExamNavbar {...props} timeLeft={299} />);
    expect(announceAssertive).toHaveBeenCalledWith('Warning: 5 minutes remaining in examination.');
    expect(vi.mocked(announceAssertive).mock.calls.filter(([label]) => label.includes('5 minutes'))).toHaveLength(1);
  });
});

describe('ExamNavbar save status', () => {
  it.each([
    ['SAVED', 'All responses saved to server', /Saved/],
    ['SAVING', 'Saving responses to server...', /Saving…/],
    ['OFFLINE', 'Offline: Responses saved to local storage', /Saved on this device/],
    ['RETRYING', 'Retrying synchronization...', /Syncing…/],
    ['FAILED', 'Autosave failed. Check connection.', /Save Failed/],
    ['CONFLICT', 'Newer server-confirmed progress was kept.', /Server Copy Kept/],
    ['LOCKED', 'The exam deadline has passed.', /Answers Locked/]
  ])('%s shows its pill and title', (status, title, text) => {
    renderNavbar({ autosaveStatus: status });
    const pill = screen.getByTitle(title);
    expect(pill.textContent).toMatch(text);
    expect(statusPills()[0].contains(pill)).toBe(true);
  });

  it('announces save status transitions to assistive technology', () => {
    const { rerender, props } = renderNavbar({ autosaveStatus: 'SAVED' });
    expect(announcePolite).not.toHaveBeenCalled();
    rerender(<ExamNavbar {...props} autosaveStatus="OFFLINE" />);
    expect(announcePolite).toHaveBeenLastCalledWith('Response saved locally offline.');
    rerender(<ExamNavbar {...props} autosaveStatus="FAILED" />);
    expect(announceAssertive).toHaveBeenLastCalledWith('Autosave failed. Check your network connection.');
    rerender(<ExamNavbar {...props} autosaveStatus="SAVED" />);
    expect(announcePolite).toHaveBeenLastCalledWith('Response saved to server.');
  });

  it('shows how long ago responses were saved', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    renderNavbar({ autosaveStatus: 'SAVED' });
    expect(screen.getByTitle('All responses saved to server').textContent).toContain('just now');
    act(() => { vi.advanceTimersByTime(12_000); });
    expect(screen.getByTitle('All responses saved to server').textContent).toContain('12s ago');
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTitle('All responses saved to server').textContent).toContain('1 min ago');
  });
});

describe('ExamNavbar network indicator', () => {
  it('reflects online/offline events and announces them', () => {
    renderNavbar();
    expect(screen.getByText(/Connection:/)).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(screen.getByTitle('Offline').textContent).toContain('Offline');
    expect(announceAssertive).toHaveBeenCalledWith(expect.stringContaining('Internet connection lost'));
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(screen.queryByTitle('Offline')).toBeNull();
    expect(announcePolite).toHaveBeenCalledWith('Internet connection restored. You are online.');
  });
});

describe('ExamNavbar subject tabs', () => {
  it('renders a tab per subject, highlights the active one and switches on click', () => {
    const { props } = renderNavbar();
    const tabs = ['Physics', 'Chemistry', 'Mathematics'].map(name => screen.getByRole('button', { name }));
    expect(tabs[1].className).toContain('bg-white');
    expect(tabs[0].className).toContain('bg-transparent');
    fireEvent.click(tabs[2]);
    expect(props.setActiveSubject).toHaveBeenCalledWith('Mathematics');
  });
});

describe('ExamNavbar countdown from a fixed deadline', () => {
  it('ticks on its own clock without new props and announces milestones', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const endTime = Date.now() + 302_000;
    const { props, rerender } = renderNavbar({ timeLeft: undefined, endTime });
    expect(screen.getByRole('timer').textContent).toBe('00:05:02');
    expect(screen.getByRole('timer').classList.contains('exam-timer--urgent')).toBe(false);

    act(() => { vi.advanceTimersByTime(2_000); });
    expect(screen.getByRole('timer').textContent).toBe('00:05:00');
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('00:05:00 remaining');
    expect(screen.getByRole('timer').classList.contains('exam-timer--urgent')).toBe(true);
    expect(announceAssertive).toHaveBeenCalledWith('Warning: 5 minutes remaining in examination.');

    // Re-rendering with unrelated prop changes keeps the same deadline.
    rerender(<ExamNavbar {...props} autosaveStatus="SAVING" />);
    act(() => { vi.advanceTimersByTime(300_000); });
    expect(screen.getByRole('timer').textContent).toBe('00:00:00');
    expect(announceAssertive).toHaveBeenCalledWith('Time expired. Examination is being submitted.');
  });
});
