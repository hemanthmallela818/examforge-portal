import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
vi.mock('../../src/supabase', () => ({ supabase: { rpc: vi.fn() } }));
import { supabase } from '../../src/supabase';
import { useSubjectTime } from '../../src/features/exam/useSubjectTime';

beforeEach(() => {
  vi.useFakeTimers();
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.mocked(supabase.rpc).mockReset().mockResolvedValue({ data: {}, error: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const options = () => ({ examState: 'ACTIVE', activeSubject: 'Physics', activeExamId: 'exam-1', currentStudent: {},
  lockdownActiveRef: { current: false }, accessGenerationRef: { current: 1 }, answerSavingRef: { current: false } });

it('piggyback acknowledgment postpones the changed-only fallback for 60 seconds', async () => {
  const config = options();
  const { result } = renderHook(() => useSubjectTime(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(supabase.rpc).not.toHaveBeenCalled();
  result.current.markSubjectTimeSaved(result.current.getSubjectTimeSnapshot());
  await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
  expect(supabase.rpc).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(supabase.rpc).toHaveBeenCalledTimes(1);
  expect(supabase.rpc.mock.calls[0][1].subject_time_seconds_param).toEqual({ Physics: 90 });
});

it('timing failures do not cause a request every second', async () => {
  vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: new Error('timing unavailable') });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const config = options();
  renderHook(() => useSubjectTime(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(supabase.rpc).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
  expect(supabase.rpc).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(supabase.rpc).toHaveBeenCalledTimes(2);
});

it('skips empty timing and avoids overlap with answer writes', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const config = options();
  renderHook(() => useSubjectTime(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(supabase.rpc).not.toHaveBeenCalled();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  config.answerSavingRef.current = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(supabase.rpc).not.toHaveBeenCalled();
});
