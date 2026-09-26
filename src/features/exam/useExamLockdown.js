/// <reference path="./browserApis.d.ts" />
// Browser lockdown for the active exam: fullscreen/keyboard lock restoration,
// warnings for leaving the exam, and the listener set that blocks shortcuts.
//
// Only actually leaving the exam counts: switching to another tab, window or
// app, or leaving fullscreen. Each time is a visible, numbered warning; once
// MAX_EXAM_WARNINGS have been given, leaving again ends the exam. Right-click,
// copy/paste and blocked keys are stopped and explained but never counted, so
// a stray key press cannot end an attempt.
import { useCallback, useEffect, useRef, useState } from 'react';
import { readExamWarningCount, saveExamWarningCount } from '../../examLogic.js';
import { showToast } from '../../utils.js';

/** Warnings before the next time the student leaves ends the exam. */
export const MAX_EXAM_WARNINGS = 2;

/** @typedef {'tab' | 'fullscreen'} ExamLeaveReason */
/** @typedef {{ count: number, reason: ExamLeaveReason }} ExamWarning */

/** @param {ExamLeaveReason} reason */
export const examLeaveReasonText = (reason) => (reason === 'fullscreen'
  ? 'You left fullscreen mode.'
  : 'You switched to another tab, window or app.');

/**
 * "…if you leave it again" / "…if you leave it 2 more times".
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
 *   points at the latest terminate handler; `warningScope` identifies the
 *   attempt whose warning count is kept on the device.
 */
export function useExamLockdown({ active, terminateExamRef, warningScope }) {
  const warningsRef = useRef(0);
  const isAlertingRef = useRef(false);
  const lockdownActiveRef = useRef(false);
  const [lockdownActive, setLockdownActive] = useState(false);
  const [warning, setWarning] = useState(/** @type {ExamWarning | null} */ (null));
  // A new warning stays on screen until the student acts on it (click or key),
  // even if fullscreen and focus come back by themselves.
  const warningUnseenRef = useRef(false);
  const scopeStudent = warningScope?.student || null;
  const scopeExamId = warningScope?.examId;

  const clearLockdown = useCallback(() => {
    warningUnseenRef.current = false;
    lockdownActiveRef.current = false;
    setLockdownActive(false);
    setWarning(null);
  }, []);

  // Restores fullscreen and, once the exam is secure again, removes the cover.
  // `studentAction` is truthy when called from the student's own click or key
  // press (event handlers pass the event), which also counts as having seen
  // the warning.
  const handleReturnToExam = useCallback(async (/** @type {unknown} */ studentAction = undefined) => {
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
      // Fullscreen is user-activation gated. The opaque exam cover remains in
      // place until the next trusted pointer/key interaction can restore it.
      console.warn('Secure fullscreen restoration is awaiting user activation:', err);
    }
  }, []);

  // Security Traps Setup
  useEffect(() => {
    if (!active) return;

    // Resume the count of this attempt (a reload must not reset it).
    const stored = readExamWarningCount({ student: scopeStudent, examId: scopeExamId, userUuid: scopeStudent?.docId });
    if (stored > warningsRef.current) warningsRef.current = stored;

    /** @param {ExamLeaveReason} reason */
    const handleLeave = (reason) => {
      if (isAlertingRef.current) return;
      isAlertingRef.current = true;
      lockdownActiveRef.current = true;
      setLockdownActive(true);
      if (warningsRef.current < MAX_EXAM_WARNINGS) {
        warningsRef.current += 1;
        saveExamWarningCount({ student: scopeStudent, examId: scopeExamId, userUuid: scopeStudent?.docId, count: warningsRef.current });
        warningUnseenRef.current = true;
        setWarning({ count: warningsRef.current, reason });
        window.focus();
        handleReturnToExam();
      } else {
        terminateExamRef.current?.(reason);
      }
    };

    let lastBlockedToastAt = 0;
    /**
     * Stops an action that is not allowed during the exam without counting it.
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
      if (isAllowedExamShortcut(e)) {
        // A bare Alt press would focus the browser menu bar on some platforms.
        if (e.key === 'Alt') e.preventDefault();
        return;
      }
      const blockedKeys = ['Escape', 'F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'F11', 'F12', 'PrintScreen'];
      if (e.ctrlKey || e.metaKey || e.altKey || blockedKeys.includes(e.key)) {
        blockAction(e, 'That key is disabled during the exam.');
      }
    };

    /** @param {Event} e */
    const handleContextMenu = (e) => blockAction(e, 'Right-click is disabled during the exam.');

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let blurTimeout;
    const handleBlur = () => {
      blurTimeout = setTimeout(() => {
        if (!document.hasFocus() || document.visibilityState === 'hidden') {
          handleLeave('tab');
        }
      }, 250);
    };
    const handleFocus = () => {
      clearTimeout(blurTimeout);
      if (lockdownActiveRef.current) handleReturnToExam();
    };

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        handleLeave('fullscreen');
      } else if (document.visibilityState === 'visible' && document.hasFocus() && !warningUnseenRef.current) {
        lockdownActiveRef.current = false;
        setLockdownActive(false);
        isAlertingRef.current = false;
        const keyboardLock = navigator.keyboard?.lock?.();
        keyboardLock?.catch(() => {});
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') handleLeave('tab');
      else if (lockdownActiveRef.current) handleReturnToExam();
    };

    /** @param {Event} event */
    const handleClipboardOrDrag = (event) => blockAction(event, 'Copy, paste and dragging are disabled during the exam.');

    /** @param {Event} event */
    const handleSecureRestoreGesture = (event) => {
      if (!lockdownActiveRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      handleReturnToExam(event);
    };

    /** @param {BeforeUnloadEvent} e */
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "You cannot exit the exam.";
      return e.returnValue;
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('contextmenu', handleContextMenu, { capture: true });
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('copy', handleClipboardOrDrag, { capture: true });
    document.addEventListener('cut', handleClipboardOrDrag, { capture: true });
    document.addEventListener('paste', handleClipboardOrDrag, { capture: true });
    document.addEventListener('dragstart', handleClipboardOrDrag, { capture: true });
    document.addEventListener('pointerdown', handleSecureRestoreGesture, { capture: true });
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('contextmenu', handleContextMenu, { capture: true });
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('copy', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('cut', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('paste', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('dragstart', handleClipboardOrDrag, { capture: true });
      document.removeEventListener('pointerdown', handleSecureRestoreGesture, { capture: true });
      window.removeEventListener('beforeunload', handleBeforeUnload);
      navigator.keyboard?.unlock?.();
      clearTimeout(blurTimeout);
    };
  }, [active, handleReturnToExam, terminateExamRef, scopeStudent, scopeExamId]);

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
