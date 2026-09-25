/// <reference path="./browserApis.d.ts" />
// Browser lockdown for the active exam: fullscreen/keyboard lock restoration,
// violation counting, and the strict listener set that blocks leaving the exam.
import { useCallback, useEffect, useRef, useState } from 'react';

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
 * @param {{ active: boolean, terminateExamRef: { current?: () => unknown } }} options
 *   `active` is true while the exam is in the ACTIVE state; `terminateExamRef`
 *   points at the latest terminate handler (the third violation terminates).
 */
export function useExamLockdown({ active, terminateExamRef }) {
  const warningsRef = useRef(0);
  const isAlertingRef = useRef(false);
  const lockdownActiveRef = useRef(false);
  const [lockdownActive, setLockdownActive] = useState(false);

  const clearLockdown = useCallback(() => {
    lockdownActiveRef.current = false;
    setLockdownActive(false);
  }, []);

  const handleReturnToExam = useCallback(async () => {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ keyboardLock: 'browser' });
      }
      if (document.fullscreenElement && navigator.keyboard?.lock) {
        await navigator.keyboard.lock();
      }
      if (document.fullscreenElement && document.visibilityState === 'visible' && document.hasFocus()) {
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

    const handleViolation = () => {
      if (isAlertingRef.current) return;
      isAlertingRef.current = true;
      lockdownActiveRef.current = true;
      setLockdownActive(true);
      if (warningsRef.current < 2) {
        warningsRef.current += 1;
        window.focus();
        handleReturnToExam();
      } else {
        if (terminateExamRef.current) {
          terminateExamRef.current();
        }
      }
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
        e.preventDefault();
        e.stopPropagation();
        handleViolation();
      }
    };

    /** @param {Event} e */
    const handleContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleViolation();
    };

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let blurTimeout;
    const handleBlur = () => {
      blurTimeout = setTimeout(() => {
        if (!document.hasFocus() || document.visibilityState === 'hidden') {
          handleViolation();
        }
      }, 250);
    };
    const handleFocus = () => {
      clearTimeout(blurTimeout);
      if (lockdownActiveRef.current) handleReturnToExam();
    };

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        handleViolation();
      } else if (document.visibilityState === 'visible' && document.hasFocus()) {
        lockdownActiveRef.current = false;
        setLockdownActive(false);
        isAlertingRef.current = false;
        const keyboardLock = navigator.keyboard?.lock?.();
        keyboardLock?.catch(() => {});
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') handleViolation();
      else if (lockdownActiveRef.current) handleReturnToExam();
    };

    /** @param {Event} event */
    const handleClipboardOrDrag = (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleViolation();
    };

    /** @param {Event} event */
    const handleSecureRestoreGesture = (event) => {
      if (!lockdownActiveRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      handleReturnToExam();
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
  }, [active, handleReturnToExam, terminateExamRef]);

  return {
    warningsRef,
    isAlertingRef,
    lockdownActiveRef,
    lockdownActive,
    clearLockdown,
    handleReturnToExam
  };
}
