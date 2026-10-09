import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';

vi.mock('../../../src/supabase', () => ({ supabase: { channel: vi.fn(), removeChannel: vi.fn(), from: vi.fn() } }));
vi.mock('../../../src/utils', () => ({ showToast: vi.fn(), customAlert: vi.fn(), customConfirm: vi.fn(), customPrompt: vi.fn() }));

const { supabase } = await import('../../../src/supabase');
const { useAdminRealtime } = await import('../../../src/features/admin/shared/useAdminRealtime');
const { useClasses, useClassesOnDemand } = await import('../../../src/features/admin/classes/useClasses');
const { AdminContext, useAdminContext } = await import('../../../src/features/admin/adminContext');

let handlers;
let services;
const visible = overrides => ({ exams: false, students: false, questions: false, classes: false, ...overrides });
const event = async (table, payload = { new: {}, old: {} }) => {
  await act(async () => {
    handlers.get(table)(payload);
    await vi.advanceTimersByTimeAsync(300);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  handlers = new Map();
  vi.mocked(supabase.channel).mockReset().mockImplementation(() => {
    const channel = {
      on: (_type, config, callback) => { handlers.set(config.table, callback); return channel; },
      subscribe: () => channel
    };
    return channel;
  });
  services = {
    loadedCollections: { current: new Set(['exams', 'students', 'questions', 'classes', 'results']) },
    visibleCollections: visible({ students: true, classes: true }),
    fetchTableCounts: vi.fn(), scheduleTableCounts: vi.fn(),
    fetchExams: vi.fn().mockResolvedValue(true), fetchExamDetail: vi.fn().mockResolvedValue(true),
    fetchResults: vi.fn().mockResolvedValue(true), activeExamIdRef: { current: null },
    fetchStudents: vi.fn(), studentsListRef: { current: [] }, locallyAddedStudents: { current: new Set() },
    fetchQuestionBank: vi.fn(), fetchClasses: vi.fn()
  };
});
afterEach(() => vi.useRealTimers());

describe('admin Realtime visible collection refresh', () => {
  it('refreshes only the open screen and its class data even if other collections were previously loaded', async () => {
    renderHook(() => useAdminRealtime(services));
    await event('students');
    await event('classes');
    await event('question_bank');
    await event('exam_status_events');
    expect(services.fetchStudents).toHaveBeenCalledTimes(1);
    expect(services.fetchClasses).toHaveBeenCalledTimes(1);
    expect(services.fetchQuestionBank).not.toHaveBeenCalled();
    expect(services.fetchExams).not.toHaveBeenCalled();
    expect(services.scheduleTableCounts).toHaveBeenCalled();
  });

  it('coalesces events and checks the current screen again before a delayed refresh', async () => {
    const { rerender } = renderHook(({ visibility }) => useAdminRealtime({ ...services, visibleCollections: visibility }), {
      initialProps: { visibility: visible({ students: true }) }
    });
    await act(async () => {
      handlers.get('students')({ new: {}, old: {} });
      handlers.get('students')({ new: {}, old: {} });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(services.fetchStudents).toHaveBeenCalledTimes(1);
    act(() => handlers.get('students')({ new: {}, old: {} }));
    rerender({ visibility: visible({ questions: true }) });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(services.fetchStudents).toHaveBeenCalledTimes(1);
    await event('question_bank');
    expect(services.fetchQuestionBank).toHaveBeenCalledTimes(1);
  });

  it('refreshes the selected exam and its results without downloading the hidden exam list', async () => {
    services.visibleCollections = visible();
    services.activeExamIdRef.current = 'selected';
    renderHook(() => useAdminRealtime(services));
    await event('exam_status_events');
    await event('student_results', { new: { exam_id: 'selected' }, old: {} });
    await event('student_results', { new: { exam_id: 'other' }, old: {} });
    expect(services.fetchExamDetail).toHaveBeenCalledWith('selected');
    expect(services.fetchResults).toHaveBeenCalledTimes(1);
    expect(services.fetchResults).toHaveBeenCalledWith('selected');
    expect(services.fetchExams).not.toHaveBeenCalled();
  });

  it('discards delayed result refreshes for an exam that is no longer selected', async () => {
    services.activeExamIdRef.current = 'selected';
    renderHook(() => useAdminRealtime(services));
    act(() => handlers.get('student_results')({ new: { exam_id: 'selected' }, old: {} }));
    services.activeExamIdRef.current = 'other';
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(services.fetchResults).not.toHaveBeenCalled();
  });

  it('retains administrator channels and removes pending refreshes on unmount', async () => {
    const { unmount } = renderHook(() => useAdminRealtime(services));
    expect([...handlers.keys()]).toEqual(['exam_status_events', 'student_results', 'students', 'question_bank', 'classes']);
    act(() => handlers.get('students')({ new: {}, old: {} }));
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(600));
    expect(services.fetchStudents).not.toHaveBeenCalled();
    expect(supabase.removeChannel).toHaveBeenCalledTimes(5);
  });
});

const loadedCollections = { current: new Set() };
const runAdminDataLoad = async (_key, _message, work) => ({ ok: true, current: true, data: await work() });
const scheduleTableCounts = () => {};
function ClassData({ enabled }) {
  const { classBook } = useAdminContext();
  useClassesOnDemand(enabled);
  return <p>{classBook.classes.map(row => row.name).join(', ')}</p>;
}
// Keep the real class loader and on-demand hook: only its Supabase boundary is faked.
function ClassesHarness({ enabled }) {
  const classBook = useClasses({ runAdminDataLoad, scheduleTableCounts, loadedCollections });
  return <AdminContext.Provider value={{ classBook, loadedCollections }}><ClassData enabled={enabled} /></AdminContext.Provider>;
}

it('reloads classes when a screen reopens after hidden changes', async () => {
  loadedCollections.current.clear();
  let rows = [{ id: 'first', name: 'Original Class', sections: ['A'] }];
  vi.mocked(supabase.from).mockImplementation(() => {
    const query = { select: () => query, order: () => query, range: () => Promise.resolve({ data: rows, error: null }) };
    return query;
  });
  const { rerender } = render(<ClassesHarness enabled />);
  await act(async () => {});
  expect(screen.getByText('Original Class')).toBeTruthy();
  rerender(<ClassesHarness enabled={false} />);
  rows = [{ id: 'new', name: 'Updated Class', sections: ['B'] }];
  rerender(<ClassesHarness enabled />);
  await act(async () => {});
  expect(screen.getByText('Updated Class')).toBeTruthy();
  expect(screen.queryByText('Original Class')).toBeNull();
});
