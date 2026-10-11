import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { anchorExamClock, getExamActionNow, resetExamClock, useDeadlineReached, useRemainingSeconds } from '../../src/features/exam/examClock';

afterEach(() => {
  resetExamClock();
  vi.useRealTimers();
});

describe('exam clock', () => {
  it('keeps an expired deadline locked when an older runtime reply arrives after a save', () => {
    let monotonic = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    anchorExamClock(1_000_000);
    const { result } = renderHook(() => useDeadlineReached(1_015_000, true));
    expect(result.current).toBe(false);

    monotonic = 20_000;
    act(() => { anchorExamClock(1_020_000); });
    expect(result.current).toBe(true);
    act(() => { anchorExamClock(1_005_000); });
    expect(getExamActionNow()).toBe(1_020_000);
    expect(result.current).toBe(true);

    monotonic += 1000;
    expect(getExamActionNow()).toBe(1_021_000);
  });

  it('accepts a forward server correction and a fresh anchor after logout', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    anchorExamClock(1_000_000);
    anchorExamClock(1_010_000);
    expect(getExamActionNow()).toBe(1_010_000);
    resetExamClock();
    anchorExamClock(900_000);
    expect(getExamActionNow()).toBe(900_000);
  });

  it('derives remaining seconds from the fixed end time once per second', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const endTime = Date.now() + 3_500;
    const { result } = renderHook(() => useRemainingSeconds(endTime));
    expect(result.current).toBe(4);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toBe(3);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current).toBe(0);
  });

  it('returns null without a deadline', () => {
    const { result } = renderHook(() => useRemainingSeconds(null));
    expect(result.current).toBeNull();
  });

  it('re-renders the deadline subscriber only when the deadline flips', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const endTime = Date.now() + 5_000;
    let renders = 0;
    const { result, rerender } = renderHook(({ enabled }) => {
      renders += 1;
      return useDeadlineReached(endTime, enabled);
    }, { initialProps: { enabled: true } });
    expect(result.current).toBe(false);
    const initialRenders = renders;

    act(() => { vi.advanceTimersByTime(4_000); });
    expect(result.current).toBe(false);
    expect(renders).toBe(initialRenders);

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current).toBe(true);
    expect(renders).toBeGreaterThan(initialRenders);

    rerender({ enabled: false });
    expect(result.current).toBe(false);
  });
});
