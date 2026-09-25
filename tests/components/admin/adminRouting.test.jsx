import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  ADMIN_TAB_PATHS,
  formatAdminPath,
  isAdminPath,
  normalizeAdminRoute,
  parseAdminPath,
  resolveInitialAdminRoute
} from '../../../src/features/admin/routing/adminRoutes';
import { useAdminRoute } from '../../../src/features/admin/routing/useAdminRoute';

describe('adminRoutes (pure mapping)', () => {
  it('maps every tab path to its tab and back', () => {
    for (const [tab, path] of Object.entries(ADMIN_TAB_PATHS)) {
      expect(parseAdminPath(path)).toEqual({ tab, examId: null });
      expect(formatAdminPath({ tab, examId: null })).toBe(path);
    }
  });

  it('tolerates trailing slashes', () => {
    expect(parseAdminPath('/admin/students/')).toEqual({ tab: 'STUDENTS', examId: null });
    expect(parseAdminPath('/admin///')).toEqual({ tab: 'DASHBOARD', examId: null });
  });

  it('parses and serialises exam deep links under the Dashboard tab', () => {
    expect(parseAdminPath('/admin/exams/exam_42-a')).toEqual({ tab: 'DASHBOARD', examId: 'exam_42-a' });
    expect(formatAdminPath({ tab: 'STUDENTS', examId: 'exam 1' })).toBe('/admin/exams/exam%201');
    expect(parseAdminPath(formatAdminPath({ tab: 'DASHBOARD', examId: 'abc' }))).toEqual({ tab: 'DASHBOARD', examId: 'abc' });
  });

  it.each([
    ['/admin/unknown'],
    ['/admin/exams/'],
    ['/admin/exams/a/b'],
    ['/admin/exams/%E0%A4%A'],
    ['/admin/exams/bad%20id'],
    [`/admin/exams/${'x'.repeat(129)}`],
    ['/administrator'],
    ['/'],
    [undefined]
  ])('rejects unknown or unsafe path %s', (path) => {
    expect(parseAdminPath(path)).toBeNull();
  });

  it('recognises only /admin and its sub-paths as admin paths', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/anything')).toBe(true);
    expect(isAdminPath('/adminx')).toBe(false);
    expect(isAdminPath('/student')).toBe(false);
  });

  it('normalises unknown tabs to the Dashboard and drops exam ids off the Dashboard', () => {
    expect(normalizeAdminRoute({ tab: 'NOPE' })).toEqual({ tab: 'DASHBOARD', examId: null });
    expect(normalizeAdminRoute({ tab: 'toString' })).toEqual({ tab: 'DASHBOARD', examId: null });
    expect(normalizeAdminRoute({ tab: 'CLASSES', examId: 'e1' })).toEqual({ tab: 'CLASSES', examId: null });
    expect(normalizeAdminRoute({ tab: 'DASHBOARD', examId: 7 })).toEqual({ tab: 'DASHBOARD', examId: '7' });
    expect(normalizeAdminRoute(null)).toEqual({ tab: 'DASHBOARD', examId: null });
    expect(formatAdminPath({ tab: 'NOPE' })).toBe('/admin');
  });

  it('restores a deep link from the initial document path only when the current path is the Dashboard', () => {
    expect(resolveInitialAdminRoute('/admin', '/admin/classes')).toEqual({ tab: 'CLASSES', examId: null });
    expect(resolveInitialAdminRoute('/admin/students', '/admin/classes')).toEqual({ tab: 'STUDENTS', examId: null });
    expect(resolveInitialAdminRoute('/admin', '/admin/exams/e9')).toEqual({ tab: 'DASHBOARD', examId: 'e9' });
    expect(resolveInitialAdminRoute('/admin', '/admin/bogus')).toEqual({ tab: 'DASHBOARD', examId: null });
    expect(resolveInitialAdminRoute('/', null)).toEqual({ tab: 'DASHBOARD', examId: null });
  });
});

describe('useAdminRoute', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/admin'); });
  afterEach(() => { window.history.replaceState(null, '', '/'); });

  it('starts from the current admin path (deep link) and keeps it canonical', () => {
    window.history.replaceState(null, '', '/admin/questions/');
    const { result } = renderHook(() => useAdminRoute());
    expect(result.current.activeTab).toBe('QUESTION_BANK');
    expect(result.current.activeExamId).toBeNull();
    expect(window.location.pathname).toBe('/admin/questions');
  });

  it('opens an exam deep link on the Dashboard', () => {
    window.history.replaceState(null, '', '/admin/exams/exam-7');
    const { result } = renderHook(() => useAdminRoute());
    expect(result.current.activeTab).toBe('DASHBOARD');
    expect(result.current.activeExamId).toBe('exam-7');
  });

  it('falls back to the Dashboard for an unknown admin path and rewrites the URL', () => {
    window.history.replaceState(null, '', '/admin/does-not-exist');
    const { result } = renderHook(() => useAdminRoute());
    expect(result.current.activeTab).toBe('DASHBOARD');
    expect(window.location.pathname).toBe('/admin');
  });

  it('navigate() pushes history entries and replace rewrites the current one', () => {
    const { result } = renderHook(() => useAdminRoute());
    const startLength = window.history.length;
    act(() => result.current.navigate({ tab: 'STUDENTS' }));
    expect(result.current.activeTab).toBe('STUDENTS');
    expect(window.location.pathname).toBe('/admin/students');
    expect(window.history.length).toBe(startLength + 1);
    expect(window.history.state.adminRoute).toBe('/admin/students');

    act(() => result.current.navigate({ tab: 'CLASSES' }, { replace: true }));
    expect(window.location.pathname).toBe('/admin/classes');
    expect(window.history.length).toBe(startLength + 1);

    act(() => result.current.navigate({ tab: 'DASHBOARD', examId: 'e1' }));
    expect(result.current.activeExamId).toBe('e1');
    expect(window.location.pathname).toBe('/admin/exams/e1');
  });

  it('restores the route on popstate (Back/Forward)', () => {
    const { result } = renderHook(() => useAdminRoute());
    act(() => {
      window.history.pushState(null, '', '/admin/operations');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.activeTab).toBe('OPERATIONS');

    act(() => {
      window.history.pushState(null, '', '/admin/exams/abc');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current).toMatchObject({ activeTab: 'DASHBOARD', activeExamId: 'abc' });

    act(() => {
      window.history.pushState(null, '', '/admin/garbage');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current).toMatchObject({ activeTab: 'DASHBOARD', activeExamId: null });
  });

  it('ignores popstate to paths outside /admin (owned by App.jsx)', () => {
    const { result } = renderHook(() => useAdminRoute());
    act(() => result.current.navigate({ tab: 'SUBJECTS' }));
    act(() => {
      window.history.pushState(null, '', '/student');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.activeTab).toBe('SUBJECTS');
  });

  it('stops listening after unmount', () => {
    const { result, unmount } = renderHook(() => useAdminRoute());
    unmount();
    window.history.pushState(null, '', '/admin/students');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(result.current.activeTab).toBe('DASHBOARD');
  });
});
