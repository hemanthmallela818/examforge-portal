import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useExamLockdown } from '../../src/features/exam/useExamLockdown';

const student = { id: 'ABC123', docId: 'uuid-abc', name: 'Student' };
const EXAM_ID = 'exam-1';

// jsdom has no fullscreen or focus model; drive both from the test.
let fullscreenElement = /** @type {Element | null} */ (null);
let visibility = 'visible';
let focused = true;

/** @param {{ onTerminate: (reason: string) => void }} props */
function Harness({ onTerminate }) {
  const terminateExamRef = useRef(onTerminate);
  terminateExamRef.current = onTerminate;
  const { lockdownActive, warning, handleReturnToExam } = useExamLockdown({
    active: true,
    terminateExamRef,
    warningScope: { student, examId: EXAM_ID }
  });
  return (
    <div>
      <p data-testid="cover">{lockdownActive ? 'covered' : 'open'}</p>
      <p data-testid="warning">{warning ? `${warning.count}:${warning.reason}` : 'none'}</p>
      <button type="button" onClick={handleReturnToExam}>Return to exam</button>
    </div>
  );
}

const leaveTab = async () => {
  visibility = 'hidden';
  focused = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};
const leaveFullscreen = async () => {
  fullscreenElement = null;
  await act(async () => { document.dispatchEvent(new Event('fullscreenchange')); });
};

describe('exam lockdown', () => {
  beforeEach(() => {
    localStorage.clear();
    fullscreenElement = document.documentElement;
    visibility = 'visible';
    focused = true;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    document.documentElement.requestFullscreen = vi.fn(async () => { fullscreenElement = document.documentElement; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (/** @type {any} */ (document)).fullscreenElement;
    delete (/** @type {any} */ (document)).visibilityState;
  });

  it('blocks right-click, copy and shortcut keys without ending the attempt', async () => {
    const onTerminate = vi.fn();
    const toasts = /** @type {string[]} */ ([]);
    const onToast = (/** @type {Event} */ event) => toasts.push(/** @type {CustomEvent} */ (event).detail.message);
    window.addEventListener('app-toast', onToast);
    render(<Harness onTerminate={onTerminate} />);

    for (let i = 0; i < 5; i += 1) {
      const rightClick = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      await act(async () => { document.body.dispatchEvent(rightClick); });
      expect(rightClick.defaultPrevented).toBe(true);
      await act(async () => { fireEvent.keyDown(window, { key: 'c', ctrlKey: true }); });
      await act(async () => { fireEvent.copy(document); });
    }
    window.removeEventListener('app-toast', onToast);

    expect(screen.getByTestId('warning').textContent).toBe('none');
    expect(screen.getByTestId('cover').textContent).toBe('open');
    expect(onTerminate).not.toHaveBeenCalled();
    expect(toasts[0]).toBe('Right-click is disabled during the exam.');
  });

  it('immediately blocks interaction and ends exam on first tab switch', async () => {
    const onTerminate = vi.fn();
    render(<Harness onTerminate={onTerminate} />);

    await leaveTab();
    expect(screen.getByTestId('cover').textContent).toBe('covered');
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('tab');
  });

  it('immediately blocks interaction and ends exam on fullscreen exit', async () => {
    const onTerminate = vi.fn();
    render(<Harness onTerminate={onTerminate} />);

    await leaveFullscreen();
    expect(screen.getByTestId('cover').textContent).toBe('covered');
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('fullscreen');
  });

  it('immediately blocks interaction and ends exam on Escape key', async () => {
    const onTerminate = vi.fn();
    render(<Harness onTerminate={onTerminate} />);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(screen.getByTestId('cover').textContent).toBe('covered');
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('escape');
  });

  it('immediately blocks interaction and ends exam on blur', async () => {
    const onTerminate = vi.fn();
    render(<Harness onTerminate={onTerminate} />);

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.getByTestId('cover').textContent).toBe('covered');
    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('blur');
  });

  it('deduplicates overlapping events to a single termination call', async () => {
    const onTerminate = vi.fn();
    render(<Harness onTerminate={onTerminate} />);

    await leaveTab();
    await leaveFullscreen();
    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith('tab');
  });
});
