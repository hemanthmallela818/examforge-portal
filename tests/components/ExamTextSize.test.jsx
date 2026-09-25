import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';

vi.mock('../../src/components/LiveAnnouncer', () => ({
  announcePolite: vi.fn(),
  announceAssertive: vi.fn()
}));

const { default: ExamNavbar } = await import('../../src/components/ExamNavbar');
const {
  examTextSizeStorageKey,
  normalizeExamTextSize,
  useExamTextSize
} = await import('../../src/features/exam/useExamTextSize');
const { isAllowedExamShortcut } = await import('../../src/features/exam/useExamLockdown');

const navbarProps = {
  subjects: ['Physics'],
  activeSubject: 'Physics',
  setActiveSubject: vi.fn(),
  timeLeft: 600,
  autosaveStatus: 'SAVED'
};

beforeEach(() => localStorage.clear());

describe('exam text size control (U11)', () => {
  it('is hidden unless the exam view wires a change handler', () => {
    render(<ExamNavbar {...navbarProps} />);
    expect(screen.queryByRole('group', { name: 'Question text size' })).toBeNull();
  });

  it('exposes three pressed-state buttons and reports the chosen level', () => {
    const onTextSizeChange = vi.fn();
    render(<ExamNavbar {...navbarProps} textSize="default" onTextSizeChange={onTextSizeChange} />);
    const group = screen.getByRole('group', { name: 'Question text size' });
    const smaller = screen.getByRole('button', { name: 'Smaller text' });
    const standard = screen.getByRole('button', { name: 'Default text size' });
    const larger = screen.getByRole('button', { name: 'Larger text' });
    expect(group.contains(larger)).toBe(true);
    expect(smaller.getAttribute('aria-pressed')).toBe('false');
    expect(standard.getAttribute('aria-pressed')).toBe('true');
    expect(larger.getAttribute('aria-pressed')).toBe('false');
    expect(larger.getAttribute('type')).toBe('button');
    fireEvent.click(larger);
    expect(onTextSizeChange).toHaveBeenCalledWith('large');
  });

  it('never relies on a modifier shortcut that lockdown would count as a violation', () => {
    // Activation is by click / Enter / Space on a focused button.
    for (const key of ['Enter', ' ', 'Tab']) {
      expect(isAllowedExamShortcut({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(false);
    }
    expect(isAllowedExamShortcut({ key: '+', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBe(false);
  });

  it('persists the preference per student in localStorage', () => {
    const first = renderHook(() => useExamTextSize('STU-1'));
    expect(first.result.current.textSize).toBe('default');
    expect(first.result.current.textScale).toBe(1);
    act(() => first.result.current.setTextSize('large'));
    expect(first.result.current.textSize).toBe('large');
    expect(first.result.current.textScale).toBeGreaterThan(1);
    expect(localStorage.getItem(examTextSizeStorageKey('STU-1'))).toBe('large');

    const again = renderHook(() => useExamTextSize('STU-1'));
    expect(again.result.current.textSize).toBe('large');
    const other = renderHook(() => useExamTextSize('STU-2'));
    expect(other.result.current.textSize).toBe('default');
  });

  it('ignores corrupt stored values', () => {
    localStorage.setItem(examTextSizeStorageKey('STU-3'), 'gigantic');
    const { result } = renderHook(() => useExamTextSize('STU-3'));
    expect(result.current.textSize).toBe('default');
    expect(normalizeExamTextSize(undefined)).toBe('default');
    expect(normalizeExamTextSize('small')).toBe('small');
  });
});
