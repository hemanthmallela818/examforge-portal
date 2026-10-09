import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';

vi.mock('../../src/supabase.js', () => ({
  supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: 'test',
  supabase: { rpc: vi.fn(), from: vi.fn(), channel: vi.fn(),
    auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: 'u1' } } } })), signOut: vi.fn(async () => ({})) } }
}));
vi.mock('../../src/utils', () => ({ customAlert: vi.fn(async () => {}) }));
const lockdown = vi.hoisted(() => ({
  warningsRef: { current: 0 }, isAlertingRef: { current: false }, lockdownActiveRef: { current: false },
  lockdownActive: false, warning: null, clearLockdown: vi.fn(), handleReturnToExam: vi.fn()
}));
vi.mock('../../src/features/exam/useExamLockdown', () => ({ useExamLockdown: () => lockdown }));

import { supabase } from '../../src/supabase.js';
import { useExamSession } from '../../src/features/exam/useExamSession.js';
import { resetExamClock } from '../../src/features/exam/examClock.js';

const initial = () => ({
  version: 1, accessGeneration: 1, endTime: Date.now() + 3_600_000,
  activeExam: { id: 'e1', title: 'Capacity test' }, activeSubject: 'Physics', currentIndices: { Physics: 0 },
  examData: { duration: 60, subjects: ['Physics'], questions: { Physics: [{ id: 'q1', type: 'MCQ', options: ['A', 'B'] }] } },
  userResponses: { Physics: [{ selectedOption: '0', status: 'ANSWERED' }] }
});
const options = () => ({ examState: 'ACTIVE', setExamState: vi.fn(),
  currentStudent: { id: 'STU1', docId: 'u1', name: 'Student' }, setCurrentStudent: vi.fn(), setResults: vi.fn(), initialActiveSession: initial() });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let saves;
let submitArgs;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); saves = []; submitArgs = [];
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.mocked(supabase.rpc).mockImplementation((name, args) => {
    let promise;
    if (name === 'sync_active_session_progress') {
      const response = deferred(); saves.push({ args, ...response }); promise = response.promise;
    } else if (name === 'submit_exam') {
      submitArgs.push(args); promise = Promise.resolve({ data: { totalScore: 4 }, error: null });
    } else if (name === 'student_exam_runtime') {
      promise = Promise.resolve({ data: { exam_status: 'ACTIVE', status: 'IN_PROGRESS', access_generation: 1, session_owned: true }, error: null });
    } else {
      promise = Promise.resolve({ data: {}, error: null });
    }
    promise.abortSignal = () => promise;
    return promise;
  });
});
afterEach(() => { cleanup(); resetExamClock(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('flushes latest answers after an in-flight autosave, freezes editing and submits the confirmed version', async () => {
  const config = options();
  const { result } = renderHook(() => useExamSession(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(saves).toHaveLength(1);
  await act(async () => { result.current.setSelectedOption('1'); });
  let submitted;
  await act(async () => { submitted = result.current.confirmSubmitExam(); });
  expect(saves).toHaveLength(1);
  await act(async () => { result.current.setSelectedOption('0'); });
  expect(result.current.currentResponse.selectedOption).toBe('1');
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2 }, error: null }); });
  expect(saves).toHaveLength(2);
  expect(saves[1].args.expected_version_param).toBe(2);
  expect(saves[1].args.responses_param.Physics[0].selectedOption).toBe('1');
  await act(async () => { saves[1].resolve({ data: { success: true, version: 3, timing_saved: true }, error: null }); await submitted; });
  expect(submitArgs[0].expected_version_param).toBe(3);
  expect(config.setExamState).toHaveBeenCalledWith('SUBMITTED');
  expect(supabase.channel).not.toHaveBeenCalled();
});

it('retries an uncertain save with the identical snapshot and expected version', async () => {
  const { result } = renderHook(() => useExamSession(options()));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  await act(async () => { saves[0].resolve({ data: null, error: { message: 'network connection failed' }, status: 503 }); });
  await act(async () => { result.current.setSelectedOption('1'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
  expect(saves[1].args).toEqual(saves[0].args);
  await act(async () => { saves[1].resolve({ data: { conflict: true, version: 2, user_responses: saves[0].args.responses_param }, error: null }); });
  expect(saves).toHaveLength(3);
  expect(saves[2].args.expected_version_param).toBe(2);
});

it('uses 250 ms debounce near the server deadline and still grades confirmed answers if timing fails', async () => {
  const config = options();
  config.initialActiveSession.endTime = Date.now() + 9_000;
  const { result } = renderHook(() => useExamSession(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(249); });
  expect(saves).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(saves).toHaveLength(1);
  expect(saves[0].args.subject_time_seconds_param).toBeTruthy();
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2, timing_saved: false }, error: null }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  vi.mocked(supabase.rpc).mockImplementationOnce(() => Promise.resolve({ data: null, error: { message: 'Timing validation failed' } }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await act(async () => { await result.current.confirmSubmitExam(); });
  expect(config.setExamState).toHaveBeenCalledWith('SUBMITTED');
});

it('restores server conflicts and does not grade a stale final snapshot', async () => {
  const config = options();
  const { result } = renderHook(() => useExamSession(config));
  let submitted;
  await act(async () => { submitted = result.current.confirmSubmitExam(); });
  const serverResponses = { Physics: [{ selectedOption: '1', status: 'ANSWERED' }] };
  await act(async () => { saves[0].resolve({ data: { conflict: true, version: 5, user_responses: serverResponses }, error: null }); await submitted; });
  expect(result.current.currentResponse.selectedOption).toBe('1');
  expect(submitArgs).toHaveLength(0);
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(submitArgs).toHaveLength(0);
});


it('recreates the save queue when React StrictMode replays effects', async () => {
  const config = options();
  renderHook(() => useExamSession(config), { wrapper: StrictMode });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(saves).toHaveLength(1);
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2 }, error: null }); });
});

it('polling fences ownership loss and preserves the local copy', async () => {
  const config = options();
  const original = supabase.rpc.getMockImplementation();
  vi.mocked(supabase.rpc).mockImplementation((name, args) => {
    if (name !== 'student_exam_runtime') return original(name, args);
    const response = Promise.resolve({ data: null, error: { code: 'EX001' } });
    response.abortSignal = () => response;
    return response;
  });
  renderHook(() => useExamSession(config));
  await act(async () => {});
  expect(config.setExamState).toHaveBeenCalledWith('AUTH');
  expect(config.setCurrentStudent).toHaveBeenCalledWith(null);
  expect(localStorage.getItem('cbt_active_exam_session')).toBeTruthy();
  expect(saves).toHaveLength(0);
});

it('detects re-granted access without adopting a new generation for pending local answers', async () => {
  const config = options();
  const original = supabase.rpc.getMockImplementation();
  vi.mocked(supabase.rpc).mockImplementation((name, args) => {
    if (name !== 'student_exam_runtime') return original(name, args);
    const response = Promise.resolve({ data: { exam_status: 'ACTIVE', status: 'IN_PROGRESS', access_generation: 2 }, error: null });
    response.abortSignal = () => response;
    return response;
  });
  const { result } = renderHook(() => useExamSession(config));
  await act(async () => {});
  expect(config.setExamState).toHaveBeenCalledWith('PRE_EXAM');
  expect(result.current.accessGeneration).toBe(1);
});

it('deadline submit waits for the in-flight save', async () => {
  const config = options(); config.initialActiveSession.endTime = Date.now() + 2000;
  renderHook(() => useExamSession(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(saves).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(submitArgs).toHaveLength(0);
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2 }, error: null }); await Promise.resolve(); });
  expect(submitArgs).toHaveLength(1);
});

it('combined save omits timing while standalone fallback is pending', async () => {
  const base = Date.now(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  const fallback = deferred(); const original = supabase.rpc.getMockImplementation();
  vi.mocked(supabase.rpc).mockImplementation((name, args) => name === 'sync_exam_subject_time' ? fallback.promise : original(name, args));
  const config = options(); const { result } = renderHook(() => useExamSession(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2, timing_saved: true }, error: null }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(supabase.rpc.mock.calls.filter(([name]) => name === 'sync_exam_subject_time')).toHaveLength(1);
  await act(async () => { result.current.setSelectedOption('1'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(saves).toHaveLength(2);
  expect(saves[1].args.subject_time_seconds_param).toBeUndefined();
  // The fallback remains unresolved while the second combined save is dispatched.
});

it('old pending snapshots are disposed when generation changes', async () => {
  const config = options();
  const { result, rerender } = renderHook(() => useExamSession(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(saves[0].args.access_generation_param).toBe(1);
  await act(async () => { result.current.setSelectedOption('1'); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(saves).toHaveLength(1); // new local answer is queued behind the delayed reply
  const original = supabase.rpc.getMockImplementation();
  vi.mocked(supabase.rpc).mockImplementation((name, args) => {
    if (name === 'student_exam_runtime') {
      const response = Promise.resolve({ data: { exam_status: 'ACTIVE', status: 'IN_PROGRESS', access_generation: 2, session_owned: true }, error: null });
      response.abortSignal = () => response; return response;
    }
    if (name === 'start_exam_session') return Promise.resolve({ data: {
      version: 2, access_generation: 2, user_responses: initial().userResponses,
      jumbled_exam_data: initial().examData, time_left: 3500
    }, error: null });
    return original(name, args);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(config.setExamState).toHaveBeenCalledWith('PRE_EXAM');
  config.examState = 'PRE_EXAM'; rerender();
  await act(async () => { await result.current.startExam(); });
  expect(result.current.currentResponse.selectedOption).toBe('0'); // server-confirmed snapshot restored
  config.examState = 'ACTIVE'; rerender();
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2, access_generation: 1 }, error: null }); });
  expect(saves).toHaveLength(1);
  expect(result.current.currentResponse.selectedOption).toBe('0');
});

it('late save reply cannot restore recovery after runtime finalization', async () => {
  const config = options();
  const { rerender } = renderHook(() => useExamSession(config));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(saves).toHaveLength(1);
  const original = supabase.rpc.getMockImplementation();
  vi.mocked(supabase.rpc).mockImplementation((name, args) => {
    if (name !== 'student_exam_runtime') return original(name, args);
    const response = Promise.resolve({ data: { exam_status: 'ACTIVE', status: 'SUBMITTED', access_generation: 1, session_owned: true,
      result: { total_score: 4, max_score: 4, correct: 1 } }, error: null });
    response.abortSignal = () => response; return response;
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(config.setExamState).toHaveBeenCalledWith('SUBMITTED');
  expect(localStorage.getItem('cbt_active_exam_session')).toBeNull();
  config.examState = 'SUBMITTED'; rerender();
  await act(async () => { saves[0].resolve({ data: { success: true, version: 2 }, error: null }); });
  expect(localStorage.getItem('cbt_active_exam_session')).toBeNull();
});
