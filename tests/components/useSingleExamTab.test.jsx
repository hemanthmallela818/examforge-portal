import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { EXAM_TAB_LOCK_WAIT_MS, useSingleExamTab } from '../../src/features/exam/useSingleExamTab';
import ExamTabLockedView from '../../src/features/exam/ExamTabLockedView';

// Minimal Web Locks stand-in: exclusive, queued, abortable, shared by every
// "tab" (hook instance) in the test, like tabs of one browser profile.
function createLockManager() {
  /** @type {Map<string, { held: boolean, queue: Array<() => void> }>} */
  const locks = new Map();
  const entry = (/** @type {string} */ name) => {
    if (!locks.has(name)) locks.set(name, { held: false, queue: [] });
    return /** @type {{ held: boolean, queue: Array<() => void> }} */ (locks.get(name));
  };
  return {
    /**
     * @param {string} name
     * @param {{ signal?: AbortSignal }} options
     * @param {() => Promise<unknown>} callback
     */
    request(name, options, callback) {
      const lock = entry(name);
      return new Promise((resolve, reject) => {
        const grant = () => {
          lock.held = true;
          Promise.resolve(callback()).then(result => {
            lock.held = false;
            lock.queue.shift()?.();
            resolve(result);
          });
        };
        if (!lock.held) { grant(); return; }
        lock.queue.push(grant);
        options.signal?.addEventListener('abort', () => {
          lock.queue = lock.queue.filter(waiter => waiter !== grant);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }
  };
}

/** @param {{ studentId: string | null, label: string }} props */
function Tab({ studentId, label }) {
  const status = useSingleExamTab(studentId);
  return <p data-testid={label}>{status}</p>;
}

describe('useSingleExamTab', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'locks');

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'locks', { value: createLockManager(), configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (original) Object.defineProperty(navigator, 'locks', original);
    else delete (/** @type {any} */ (navigator)).locks;
  });

  const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  it('lets the first tab run the exam', async () => {
    render(<Tab studentId="student-1" label="a" />);
    await flush();
    expect(screen.getByTestId('a').textContent).toBe('owner');
  });

  it('blocks a second tab for the same student and frees it when the first tab closes', async () => {
    const first = render(<Tab studentId="student-1" label="a" />);
    await flush();
    render(<Tab studentId="student-1" label="b" />);
    await flush(EXAM_TAB_LOCK_WAIT_MS);
    expect(screen.getByTestId('b').textContent).toBe('blocked');

    first.unmount();
    await flush();
    expect(screen.getByTestId('b').textContent).toBe('free');
  });

  it('does not block a different student', async () => {
    render(<Tab studentId="student-1" label="a" />);
    render(<Tab studentId="student-2" label="b" />);
    await flush();
    expect(screen.getByTestId('a').textContent).toBe('owner');
    expect(screen.getByTestId('b').textContent).toBe('owner');
  });

  it('does not lock outside the exam', async () => {
    render(<Tab studentId={null} label="a" />);
    await flush();
    expect(screen.getByTestId('a').textContent).toBe('owner');
  });

  it('checks again when the student re-enters the exam', async () => {
    const view = render(<Tab studentId="student-1" label="a" />);
    await flush();
    // Tab a leaves the exam and tab b opens it meanwhile.
    view.rerender(<Tab studentId={null} label="a" />);
    await flush();
    render(<Tab studentId="student-1" label="b" />);
    await flush();
    expect(screen.getByTestId('b').textContent).toBe('owner');

    view.rerender(<Tab studentId="student-1" label="a" />);
    await flush(EXAM_TAB_LOCK_WAIT_MS);
    expect(screen.getByTestId('a').textContent).toBe('blocked');
  });

  it('runs every tab when the browser has no Web Locks', async () => {
    delete (/** @type {any} */ (navigator)).locks;
    render(<Tab studentId="student-1" label="a" />);
    render(<Tab studentId="student-1" label="b" />);
    await flush(EXAM_TAB_LOCK_WAIT_MS);
    expect(screen.getByTestId('a').textContent).toBe('owner');
    expect(screen.getByTestId('b').textContent).toBe('owner');
  });
});

describe('ExamTabLockedView', () => {
  it('explains the block and keeps Continue disabled while the other tab is open', () => {
    const onContinueHere = vi.fn();
    render(<ExamTabLockedView status="blocked" onContinueHere={onContinueHere} />);
    expect(screen.getByRole('heading', { name: 'This exam is already open in another tab' })).toBeTruthy();
    expect(/** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Continue in this tab' })).disabled).toBe(true);
  });

  it('offers to continue once the other tab is closed', () => {
    const onContinueHere = vi.fn();
    render(<ExamTabLockedView status="free" onContinueHere={onContinueHere} />);
    screen.getByRole('button', { name: 'Continue in this tab' }).click();
    expect(onContinueHere).toHaveBeenCalledOnce();
  });
});
