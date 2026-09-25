import { useState, useEffect, useRef } from 'react';
import { useDialogFocusTrap } from '../dialogFocus';
import { AlertTriangle, CheckCircle2, CircleHelp, Info, PenLine, X, XCircle } from 'lucide-react';
import { Button, Input, cn } from './ui';

/**
 * @typedef {import('../types').ToastEventDetail & { id: string }} ToastItem
 * @typedef {object} DialogState
 * @property {string} id
 * @property {import('../types').DialogType} type
 * @property {string} message
 * @property {string} defaultValue
 * @property {string} value
 * @property {(value: import('../types').UntrustedInput) => void} onResolve
 */

const CustomPopupContainer = () => {
  const [toasts, setToasts] = useState(/** @type {ToastItem[]} */ ([]));
  const [dialog, setDialog] = useState(/** @type {DialogState | null} */ (null)); // { id, type, message, defaultValue, value, onResolve }
  const promptInputRef = useRef(/** @type {HTMLInputElement | null} */ (null));

  useEffect(() => {
    /** @param {Event} event */
    const handleToast = (event) => {
      const e = /** @type {CustomEvent<import('../types').ToastEventDetail>} */ (event);
      const { message, type } = e.detail;
      const id = Math.random().toString(36).substring(2);
      setToasts((prev) => [...prev, { id, message, type }]);

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    };

    /** @param {Event} event */
    const handleDialog = (event) => {
      const e = /** @type {CustomEvent<import('../types').DialogEventDetail>} */ (event);
      // Acknowledge receipt so the dispatcher (utils.js requestDialog) knows a
      // host is mounted and will resolve the promise. If no host calls
      // preventDefault, the dispatcher resolves a safe default instead of
      // leaving the caller awaiting forever.
      e.preventDefault();
      const { type, message, defaultValue, onResolve } = e.detail;
      setDialog({
        id: Math.random().toString(36).substring(2),
        type,
        message,
        defaultValue: defaultValue || '',
        value: defaultValue || '',
        onResolve
      });
    };

    window.addEventListener('app-toast', handleToast);
    window.addEventListener('show-dialog', handleDialog);

    return () => {
      window.removeEventListener('app-toast', handleToast);
      window.removeEventListener('show-dialog', handleDialog);
    };
  }, []);

  // Autofocus input in case of prompt
  useEffect(() => {
    if (dialog && dialog.type === 'prompt' && promptInputRef.current) {
      promptInputRef.current.focus();
      promptInputRef.current.select();
    }
  // Re-focus only when a new dialog opens; depending on the full dialog would
  // select the prompt text again after every keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialog?.id]);

  /** @param {string} id */
  const removeToast = (id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  /** @param {boolean} confirmAction */
  const handleDialogAction = (confirmAction) => {
    if (!dialog) return;

    /** @type {boolean | string | null} */
    let result = false;
    if (dialog.type === 'alert') {
      result = true;
    } else if (dialog.type === 'confirm') {
      result = confirmAction;
    } else if (dialog.type === 'prompt') {
      result = confirmAction ? dialog.value : null;
    }

    dialog.onResolve(result);
    setDialog(null);
  };

  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({
    active: Boolean(dialog),
    activationKey: dialog?.id,
    onEscape: () => handleDialogAction(false),
    initialFocusRef: dialog?.type === 'prompt' ? promptInputRef : undefined
  });

  /** @param {import('react').KeyboardEvent<HTMLElement>} e */
  const handleKeyDown = (e) => {
    handleDialogKeyDown(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && e.target === promptInputRef.current) {
      e.preventDefault();
      handleDialogAction(true);
    }
  };

  /** @type {Record<import('../types').ToastType, { icon: import('react').ElementType, className: string, iconClassName: string }>} */
  const toastStyles = {
    success: { icon: CheckCircle2, className: 'border-emerald-200 bg-emerald-50 text-emerald-900', iconClassName: 'text-emerald-600' },
    error: { icon: XCircle, className: 'border-red-200 bg-red-50 text-red-900', iconClassName: 'text-red-600' },
    warning: { icon: AlertTriangle, className: 'border-amber-200 bg-amber-50 text-amber-900', iconClassName: 'text-amber-600' },
    info: { icon: Info, className: 'border-slate-200 bg-white text-slate-800', iconClassName: 'text-brand-600' }
  };

  /** @type {Record<import('../types').DialogType | 'error', { icon: import('react').ElementType, className: string }>} */
  const dialogIcon = {
    alert: { icon: Info, className: 'bg-brand-50 text-brand-600 ring-brand-100' },
    confirm: { icon: CircleHelp, className: 'bg-amber-50 text-amber-600 ring-amber-100' },
    prompt: { icon: PenLine, className: 'bg-brand-50 text-brand-600 ring-brand-100' },
    error: { icon: XCircle, className: 'bg-red-50 text-red-600 ring-red-100' }
  };
  // Only rendered inside `{dialog && ...}`, where the icon is always resolved.
  const DialogIcon = /** @type {{ icon: import('react').ElementType, className: string }} */ (dialog ? (dialogIcon[dialog.type] || dialogIcon.alert) : null);
  const isDestructiveConfirm = dialog?.type === 'confirm' && dialog.message.includes('WIPE');

  return (
    <>
      {/* Toast Notifications Stack */}
      <div aria-live="polite" aria-atomic="false" className="pointer-events-none fixed right-4 top-4 z-[10000] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2.5">
        {toasts.map((toast) => {
          const tone = toastStyles[toast.type] || toastStyles.info;
          const ToastIcon = tone.icon;

          return (
            <div
              key={toast.id}
              onClick={() => removeToast(toast.id)}
              className={cn(
                'pointer-events-auto flex cursor-pointer select-none items-start gap-3 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg animate-[slideIn_0.3s_ease-out_forwards]',
                tone.className
              )}
            >
              <ToastIcon className={cn('mt-0.5 size-5 shrink-0', tone.iconClassName)} aria-hidden="true" />
              <span className="min-w-0 flex-1 leading-relaxed">{toast.message}</span>
              <button
                type="button"
                aria-label="Dismiss notification"
                className="-mr-1 grid size-6 shrink-0 place-items-center rounded-md bg-transparent p-0 text-current opacity-60 hover:bg-black/5 hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  removeToast(toast.id);
                }}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Custom Dialog Modal */}
      {dialog && (
        <div role="presentation" className="fixed inset-0 z-[10001] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out_forwards]">
          <div 
            ref={/** @type {import('react').RefObject<HTMLDivElement>} */ (dialogRef)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            tabIndex={-1}
            className="animate-fade-in flex w-full max-w-md flex-col gap-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
            onKeyDown={handleKeyDown}
          >
            <div className="flex items-start gap-4">
              <div className={cn('grid size-11 shrink-0 place-items-center rounded-full ring-4', isDestructiveConfirm ? 'bg-red-50 text-red-600 ring-red-100' : DialogIcon.className)}>
                {isDestructiveConfirm
                  ? <AlertTriangle className="size-5" aria-hidden="true" />
                  : <DialogIcon.icon className="size-5" aria-hidden="true" />}
              </div>
              <div className="min-w-0 flex-1 pt-1">
                <h3 id="app-dialog-title" className="mb-1.5 text-base font-semibold text-slate-900">
                  {dialog.type === 'alert' && 'Notification'}
                  {dialog.type === 'confirm' && 'Confirmation Required'}
                  {dialog.type === 'prompt' && 'Input Required'}
                </h3>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-600">
                  {dialog.message}
                </p>
              </div>
            </div>

            {dialog.type === 'prompt' && (
              <Input
                ref={promptInputRef}
                type="text"
                value={dialog.value}
                onChange={(e) => setDialog((prev) => /** @type {DialogState} */ ({ ...prev, value: e.target.value }))}
              />
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              {(dialog.type === 'confirm' || dialog.type === 'prompt') && (
                <Button
                  variant="secondary"
                  onClick={() => handleDialogAction(false)}
                >
                  Cancel
                </Button>
              )}
              <Button
                variant={isDestructiveConfirm ? 'danger' : 'primary'}
                className="sm:min-w-24"
                onClick={() => handleDialogAction(true)}
              >
                {dialog.type === 'confirm' ? 'Confirm' : 'OK'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Slide-in style for toasts */}
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateX(100px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
      `}</style>
    </>
  );
};

export default CustomPopupContainer;
