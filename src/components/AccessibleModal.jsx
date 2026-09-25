import { useDialogFocusTrap } from '../dialogFocus';

/**
 * @typedef {object} AccessibleModalProps
 * @property {string} labelledBy
 * @property {() => void} [onEscape]
 * @property {import('react').RefObject<HTMLElement | null>} [returnFocusRef]
 * @property {string} [maxWidth]
 * @property {import('react').ReactNode} [children]
 */

/** @param {AccessibleModalProps} props */
const AccessibleModal = ({ labelledBy, onEscape, returnFocusRef, maxWidth = '500px', children }) => {
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({ onEscape, returnFocusRef });

  return (
    <div
      ref={/** @type {import('react').RefObject<HTMLDivElement>} */ (dialogRef)}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      className="exam-modal-backdrop fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm sm:p-5"
    >
      <div
        className="animate-fade-in exam-modal-content max-h-[calc(100dvh-40px)] w-full overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-2xl sm:p-8"
        style={{ maxWidth }}
      >
        {children}
      </div>
    </div>
  );
};

export default AccessibleModal;
