// Keeps a student's exam open in only one tab of the browser. Tabs of the same
// browser share one sign-in, so the server cannot tell them apart; a Web Lock
// (per origin, released automatically when the tab closes or crashes) can.
import { useEffect, useState } from 'react';

/** How long to wait for the lock before treating it as held by another tab. */
export const EXAM_TAB_LOCK_WAIT_MS = 400;

/** @param {string} studentId */
export const examTabLockName = (studentId) => `examforge-exam-tab:${studentId}`;

/**
 * - `owner`: this tab runs the exam (also when Web Locks are unavailable).
 * - `checking`: waiting briefly for the lock.
 * - `blocked`: another tab has the exam open.
 * - `free`: the other tab closed; this tab now holds the lock but must reload
 *   to pick up the latest saved answers before continuing.
 * @typedef {'owner' | 'checking' | 'blocked' | 'free'} ExamTabStatus
 */

const locksSupported = () => typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';

/**
 * @param {string | null | undefined} studentId  Lock only while set (pre-exam and active exam).
 * @returns {ExamTabStatus}
 */
export function useSingleExamTab(studentId) {
  // The status is tied to the lock it describes, so a new lock key reads as
  // `checking` from its first render, before the effect below has run.
  const [state, setState] = useState(/** @type {{ key: string | null, status: ExamTabStatus }} */ ({ key: null, status: 'owner' }));
  const key = studentId && locksSupported() ? studentId : null;

  useEffect(() => {
    if (!key) return undefined;
    /** @param {ExamTabStatus} status */
    const setStatus = status => setState({ key, status });
    const controller = new AbortController();
    /** @type {(() => void) | null} */
    let release = null;
    let granted = false;
    let wasBlocked = false;
    setStatus('checking');
    // A queued request (not ifAvailable) so a lock released a moment ago, e.g.
    // by a React StrictMode remount, is still acquired by this tab.
    const timer = setTimeout(() => {
      if (granted) return;
      wasBlocked = true;
      setStatus('blocked');
    }, EXAM_TAB_LOCK_WAIT_MS);
    navigator.locks.request(examTabLockName(key), { signal: controller.signal }, () => {
      granted = true;
      clearTimeout(timer);
      setStatus(wasBlocked ? 'free' : 'owner');
      return new Promise(resolve => { release = () => resolve(undefined); });
    }).catch(() => {
      // AbortError when this tab stops waiting (cleanup); nothing to release.
    });
    return () => {
      clearTimeout(timer);
      controller.abort();
      release?.();
      // Forget this lock's result so re-entering the exam checks again.
      setState({ key: null, status: 'owner' });
    };
  }, [key]);

  if (!key) return 'owner';
  return state.key === key ? state.status : 'checking';
}
