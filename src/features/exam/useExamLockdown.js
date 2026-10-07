/// <reference path="./browserApis.d.ts" />
// Browser lockdown for the active exam: immediate single-event termination
// on Escape, hidden-tab events, window blur, or fullscreen exit.
// Interactions are immediately blocked locally before awaiting network responses.
// Right-click, copy/paste and blocked keys are stopped and explained without
// ending the attempt.
import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '../../utils.js';

/** Legacy export preserved for contract compatibility. */
export const MAX_EXAM_WARNINGS = 2;

/** @typedef {'tab' | 'fullscreen' | 'escape' | 'blur' | 'ended'} ExamLeaveReason */
/** @typedef {{ count: number, reason: ExamLeaveReason }} ExamWarning */

/** @param {ExamLeaveReason} reason */
export const examLeaveReasonText = (reason) => {
  if (reason === 'fullscreen') return 'You left fullscreen mode.';
  if (reason === 'escape') return 'You pressed the Escape key.';
  if (reason === 'blur') return 'The exam window lost focus.';
  return 'You switched to another tab, window or app.';
};

/**
 * Legacy consequence text preserved for contract compatibility.
 * @param {number} count warnings given so far
 */
export const examWarningConsequenceText = (count) => {
  const remaining = Math.max(1, MAX_EXAM_WARNINGS - count + 1);
  return `Your exam will end automatically if you leave it ${remaining === 1 ? 'again' : `${remaining} more times`}.`;
};

const BLOCKED_ACTION_TOAST_MS = 2500;

// The exam's own keyboard shortcuts (QuestionPanel: Alt+S/M/C/N/P, Ctrl+Enter)
// and bare modifier presses are not violations; every other Ctrl/Alt/Meta
// combination and the listed keys are blocked and counted.
const EXAM_SHORTCUT_KEYS = new Set(['s', 'm', 'c', 'n', 'p']);
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'OS']);
/** @param {Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>} e */
export const isAllowedExamShortcut = (e) => {
  if (MODIFIER_KEYS.has(e.key)) return true;
  const key = String(e.key || '').toLowerCase();
  if (e.altKey && !e.ctrlKey && !e.metaKey && EXAM_SHORTCUT_KEYS.has(key)) return true;
  return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'Enter';
};

/**
 * @param {{
 *   active: boolean,
 *   terminateExamRef: { current?: (reason: ExamLeaveReason) => unknown },
 *   warningScope?: { student: import('./examSessionHelpers').CurrentStudent | null, examId: string | undefined }
 * }} options
 *   `active` is true while the exam is in the ACTIVE state; `terminateExamRef`
 *   points at the latest terminate handler; `warningScope` identifies the attempt.
 */
export function useExamLockdown({ active, terminateExamRef, warningScope }) {
  const warningsRef = useRef(0);
  const isAlertingRef = useRef(false);
  const terminatedRef = useRef(false);
  const lockdownActiveRef = useRef(false);
  const [lockdownActive, setLockdownActive] = useState(false);
  const [warning, setWarning] = useState(/** @type {ExamWarning | null} */ (null));
  const warningUnseenRef = useRef(false);
  const scopeStudent = warningScope?.student || null;
  const scopeExamId = warningScope?.examId;

  const clearLockdown = useCallback(() => {
    warningUnseenRef.current = false;
    terminatedRef.current = false;
    isAlertingRef.current = false;
    lockdownActiveRef.current = false;
    setLockdownActive(false);
    setWarning(null);
  }, []);

  const handleReturnToExam = useCallback(async (/** @type {unknown} */ studentAction = undefined) => {
    if (terminatedRef.current) return;
    if (studentAction) warningUnseenRef.current = false;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ keyboardLock: 'browser' });
      }
      if (document.fullscreenElement && navigator.keyboard?.lock) {
        await navigator.keyboard.lock();
      }
      if (document.fullscreenElement && document.visibilityState === 'visible' && document.hasFocus()
          && !warningUnseenRef.current) {
        lockdownActiveRef.current = false;
        setLockdownActive(false);
        isAlertingRef.current = false;
      }
    } catch (err) {
      console.warn('Secure fullscreen restoration is awaiting user activation:', err);
    }
  }, []);

  // Security Traps Setup
  useEffect(() => {
    if (!active) return;

    /** @param {ExamLeaveReason} reason */
    const handleLeave = (reason) => {
      if (terminatedRef.current || isAlertingRef.current) return;
      terminatedRef.current = true;
      isAlertingRef.current = true;
      lockdownActiveRef.current = true;
      setLockdownActive(true);
      terminateExamRef.current?.(reason);
    };

    let lastBlockedToastAt = 0;
    /**
     * Stops an action that is not allowed during the exam without ending the attempt.
     * @param {Event} event
     * @param {string} message
     */
    const blockAction = (event, message) => {
      event.preventDefault();
      event.stopPropagation();
      const now = Date.now();
      if (now - lastBlockedToastAt < BLOCKED_ACTION_TOAST_MS) return;
      lastBlockedToastAt = now;
      showToast(message, 'warning');
    };

    /** @param {KeyboardEvent} e */
    const handleKeyDown = (e) => {
      if (terminatedRef.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (isAllowedExamShortcut(e)) {
        if (e.key === 'Alt') e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        blockAction(e, 'Leaving the exam is not allowed.');
        handleLeave('escape');
        return;
      }
      const blockedKeys = ['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12', 'PrintScreen'];
      if (e.ctrlKey || e.metaKey || e.altKey || blockedKeys.includes(e.key)) {
        blockAction(e, 'That key is disabled during the exam.');
      }
    };

    /** @param {Event} e */
    const handleContextMenu = (e) => blockAction(e, 'Right-click is disabled during the exam.');

    const handleBlur = () => {
      handleLeave('blur');
    };

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        handleLeave('fullscreen');
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        handleLeave('tab');
      }
    };

    /** @param {Event} event */
    const handleClipboardOrDrag = (event) => blockAction(event, 'Copy, paste and dragging are disabled during the exam.');

    /** @param {BeforeUnloadEvent} e */
    const handleBeforeUnload = (e) => {
      handleLeave('ended');
      e.preventDefault();
      e.returnValue = "You cannot exit the exam.";
      return e.returnValue;
    };

    const handlePageHide = () => {
      handleLeave('ended');
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('contextmenu', handleContextMenu, { capture: true });
    window.addEventListener('blur', handleBlur);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('copy', handleClipboardOrDrag, { capture: true });
    document.addEventListener('cut', handleClipboardOrDrag, { capture: true });
    document.addEventListener('paste', handleClipboardOrDrag, { capture: true });
    document.addEventListener('dragstart', handleClipboardOrDrag, { capture: true });
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('contextmenu', handleContextMenu, { capture: true });
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('copy', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('cut', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('paste', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('dragstart', handleClipboardOrDrag, { capture: true });
      window.removeEventListener('beforeunload', handleBeforeUnload);
      navigator.keyboard?.unlock?.();
    };
  }, [active, terminateExamRef, scopeStudent, scopeExamId]);

  return {
    warningsRef,
    isAlertingRef,
    lockdownActiveRef,
    lockdownActive,
    warning,
    clearLockdown,
    handleReturnToExam
  };
}
