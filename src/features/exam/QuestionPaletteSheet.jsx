// Bottom-sheet presentation of the question palette for phones and tablets
// (U14). On wide screens GridPanel stays docked beside the question.
//
// Escape is deliberately not a close key: the exam lockdown counts it as a
// violation (and it leaves fullscreen), so the sheet closes from its Close
// button, the backdrop, or choosing a question.
import { X } from 'lucide-react';
import { useDialogFocusTrap } from '../../dialogFocus';

/**
 * @param {{
 *   onClose: () => void,
 *   subject?: string,
 *   returnFocusRef?: import('react').RefObject<HTMLElement | null>,
 *   children: import('react').ReactNode
 * }} props
 */
export default function QuestionPaletteSheet({ onClose, subject, returnFocusRef, children }) {
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({ returnFocusRef });

  /** @param {import('react').MouseEvent<HTMLDivElement>} event */
  const closeAfterQuestionChoice = (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    // Pointer or Enter/Space activation of a palette button picks a question;
    // arrow-key roving inside the palette does not click and keeps it open.
    if (target.closest?.('[id^="q-palette-btn-"]')) onClose();
  };

  return (
    <div className="fixed inset-0 z-[80] flex flex-col justify-end">
      <div className="absolute inset-0 bg-slate-950/50" aria-hidden="true" onClick={onClose} />
      <div
        ref={/** @type {import('react').RefObject<HTMLDivElement>} */ (dialogRef)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-palette-sheet-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        onClick={closeAfterQuestionChoice}
        className="exam-palette-sheet relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2">
          <div className="min-w-0">
            <h2 id="question-palette-sheet-title" className="text-base font-semibold text-slate-900">Questions</h2>
            {subject && <p className="truncate text-xs text-slate-500">{subject}</p>}
          </div>
          <button
            type="button"
            data-modal-autofocus
            onClick={onClose}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <X className="size-4" aria-hidden="true" /> Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
      </div>
    </div>
  );
}
