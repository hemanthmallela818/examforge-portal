import { useEffect, useRef } from 'react';

export const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

export const useDialogFocusTrap = ({
  active = true,
  activationKey = active,
  onEscape,
  initialFocusRef,
  returnFocusRef
} = {}) => {
  const dialogRef = useRef(null);
  const escapeHandlerRef = useRef(onEscape);
  const capturedReturnFocusRef = useRef(null);
  const capturedActivationKeyRef = useRef(Symbol('uninitialized-dialog-activation'));
  escapeHandlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return undefined;
    // React Strict Mode replays effects in development. Preserve the original
    // opener for the whole activation so the replay cannot replace it with a
    // control that lives inside the dialog and disappears on close.
    if (capturedActivationKeyRef.current !== activationKey || !capturedReturnFocusRef.current) {
      capturedActivationKeyRef.current = activationKey;
      capturedReturnFocusRef.current = returnFocusRef?.current || document.activeElement;
    }
    const frame = requestAnimationFrame(() => {
      const preferred = initialFocusRef?.current
        || dialogRef.current?.querySelector('[data-modal-autofocus]');
      const first = dialogRef.current?.querySelector(FOCUSABLE_SELECTOR);
      (preferred || first || dialogRef.current)?.focus();
    });
    const handleDocumentEscape = (event) => {
      if (event.key !== 'Escape' || !escapeHandlerRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      escapeHandlerRef.current();
    };
    // Capture at the document boundary so Escape remains reliable when a
    // browser or nested control does not bubble the key event to the backdrop.
    document.addEventListener('keydown', handleDocumentEscape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleDocumentEscape, true);
      const returnTarget = returnFocusRef?.current || capturedReturnFocusRef.current;
      if (typeof HTMLElement !== 'undefined'
          && returnTarget instanceof HTMLElement
          && returnTarget.isConnected) returnTarget.focus();
    };
  }, [active, activationKey, initialFocusRef, returnFocusRef]);

  const handleDialogKeyDown = (event) => {
    if (event.key === 'Escape') return;
    if (event.key !== 'Tab') return;
    const focusable = [...(dialogRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) || [])]
      .filter(element => element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return { dialogRef, handleDialogKeyDown };
};
