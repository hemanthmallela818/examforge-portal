import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('../../src/supabase.js', () => {
  const channel = { on: vi.fn(() => channel), subscribe: vi.fn(() => channel) };
  const query = { select: vi.fn(() => query), eq: vi.fn(() => query), single: vi.fn(async () => ({ data: null, error: null })) };
  return {
    supabaseUrl: 'http://127.0.0.1:54321', supabaseAnonKey: 'mock-public-key',
    supabase: {
      rpc: vi.fn((name) => name === 'terminate_exam' ? new Promise(() => {}) : Promise.resolve({ data: { success: true, version: 2 }, error: null })),
      from: vi.fn(() => query), channel: vi.fn(() => channel), removeChannel: vi.fn(),
      auth: { getSession: vi.fn(async () => ({ data: { session: { user: { id: '00000000-0000-4000-8000-000000000001' }, access_token: 'mock-token' } } })) }
    }
  };
});

import { supabase } from '../../src/supabase.js';
import { useExamSession } from '../../src/features/exam/useExamSession.js';
import ActiveExamView from '../../src/features/exam/ActiveExamView.jsx';

const student = { id: 'REVIEW-STUDENT', docId: '00000000-0000-4000-8000-000000000001', name: 'Review student' };
const options = () => ({
  examState: 'ACTIVE', setExamState: vi.fn(), currentStudent: student, setCurrentStudent: vi.fn(), setResults: vi.fn(),
  initialActiveSession: { accessGeneration: 2, version: 1, endTime: Date.now() + 3600000,
    activeExam: { id: '00000000-0000-4000-8000-000000000002', title: 'Review exam' },
    activeSubject: 'Physics', currentIndices: {Physics: 0},
    examData: { duration: 60, subjects: ['Physics'], questions: {Physics: [{id: 'q1', text: 'Example?', type: 'MCQ', options: ['A','B','C','D']}] } },
    userResponses: {Physics: [{selectedOption: 1, status: 'ANSWERED'}]}
  }
});

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.stubGlobal('fetch',vi.fn(() => new Promise(() => {}))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('exam session termination regressions', () => {
  it('keeps the access generation in immediate local recovery', async () => {
    const { result } = renderHook(() => useExamSession(options()));
    await act(async () => {});
    expect(result.current.accessGeneration).toBe(2);
    const mirror = JSON.parse(localStorage.getItem('cbt_active_exam_session'));
    expect(mirror.accessGeneration).toBe(2);
  });
  it('dispatches keepalive termination immediately on pagehide', async () => {
    const { result } = renderHook(() => useExamSession(options()));
    await act(async () => {});
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(result.current.isTerminating).toBe(true);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/rpc/terminate_exam'), expect.objectContaining({ keepalive: true, body: expect.stringContaining('access_generation_param') }));
  });
  it('blocks answer mutation while termination is pending', async () => {
    const { result } = renderHook(() => useExamSession(options()));
    await act(async () => { window.dispatchEvent(new Event('blur')); });
    expect(result.current.isTerminating).toBe(true);
    await act(async () => { result.current.setSelectedOption('2'); });
    expect(result.current.currentResponse.selectedOption).toBe(1);
  });
  it('blocks Alt+C behind the security cover', async () => {
    function Harness() {
      const session = useExamSession(options());
      return createElement(ActiveExamView, { session, currentStudent: student });
    }
    render(createElement(Harness));
    await screen.findAllByRole('radio');
    await waitFor(() => expect(supabase.auth.getSession).toHaveBeenCalled());
    expect(document.querySelectorAll('input[type="radio"]:checked')).toHaveLength(1);
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.getByText('Ending your exam…')).toBeTruthy();
    await act(async () => { fireEvent.keyDown(window, {key: 'c', altKey: true}); });
    expect(document.querySelectorAll('input[type="radio"]:checked')).toHaveLength(1);
  });
});


it('can start the next re-granted attempt after a completed local termination', async () => {
  const config = options();
  const { result } = renderHook(() => useExamSession(config));
  await act(async () => {});
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ terminated: true }) });
  await act(async () => { await result.current.terminateExam('escape'); });
  expect(config.setExamState).toHaveBeenCalledWith('TERMINATED');
  const exam = { ...config.initialActiveSession.activeExam, questionsData: config.initialActiveSession.examData };
  vi.mocked(supabase.rpc).mockResolvedValue({ data: {
    access_generation: 3, version: 1, time_left: 1800,
    jumbled_exam_data: config.initialActiveSession.examData,
    user_responses: config.initialActiveSession.userResponses
  }, error: null });
  await act(async () => { await result.current.handleStartExamFlow(exam); });
  await act(async () => { await result.current.startExam(); });
  expect(config.setExamState).toHaveBeenCalledWith('ACTIVE');
  expect(result.current.accessGeneration).toBe(3);
  await act(async () => { result.current.setSelectedOption('2'); });
  expect(result.current.currentResponse.selectedOption).toBe('2');
});
