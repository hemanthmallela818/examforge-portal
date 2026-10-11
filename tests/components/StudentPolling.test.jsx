import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStudentPoller } from '../../src/studentPolling.js';
import { anchorExamClock, getExamClockNow, resetExamClock } from '../../src/features/exam/examClock.js';

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); });
afterEach(() => { resetExamClock(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('schedules from completion, coalesces refreshes, postpones after saves and cancels disposal', async () => {
  let finish;
  const poll = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const owner = createStudentPoller(poll);
  owner.refresh();
  owner.refresh();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(poll).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(24_000);
  owner.postpone();
  await vi.advanceTimersByTimeAsync(24_000);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(poll).toHaveBeenCalledTimes(2);
  const signal = poll.mock.calls[1][0];
  owner.dispose();
  expect(signal.aborted).toBe(true);
  finish();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(poll).toHaveBeenCalledTimes(2);
});

it('backs off failures and refreshes immediately on visible return and reconnect', async () => {
  const poll = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue();
  const owner = createStudentPoller(poll);
  await owner.refresh();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(poll).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(25_000);
  expect(poll).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(100_000);
  expect(poll).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(0);
  expect(poll).toHaveBeenCalledTimes(3);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  window.dispatchEvent(new Event('offline'));
  await vi.advanceTimersByTimeAsync(100_000);
  expect(poll).toHaveBeenCalledTimes(3);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(0);
  expect(poll).toHaveBeenCalledTimes(4);
  owner.dispose();
});

it('aborts a hidden read and waits for it to settle before refreshing on return', async () => {
  let finish;
  const poll = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const owner = createStudentPoller(poll);
  owner.refresh();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(poll.mock.calls[0][0].aborted).toBe(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(poll).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(poll).toHaveBeenCalledTimes(2);
  owner.dispose();
  finish();
});

it('anchors the countdown to server time and ignores wall clock changes', () => {
  let monotonic = 500;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const server = Date.parse('2026-10-08T06:00:00Z');
  anchorExamClock(new Date(server).toISOString());
  vi.setSystemTime(Date.now() - 3_600_000);
  monotonic += 10_000;
  expect(getExamClockNow()).toBe(server + 10_000);
});
