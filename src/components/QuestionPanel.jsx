import { memo, useCallback, useEffect, useRef, useState } from 'react';
import MathRenderer from './MathRenderer';
import StorageImage from './StorageImage';
import { AlertTriangle, BookmarkCheck, ChevronLeft, ChevronRight, Delete, Eraser, Flag, Hash, Info, Keyboard, ListChecks, Save, Send } from 'lucide-react';
import { Badge, Button, Input, cn } from './ui';
import {
  CANDIDATE_NUMERICAL_MAX_LENGTH,
  NUMERICAL_ABSOLUTE_TOLERANCE,
  validateNumericalAnswer
} from '../numericalAnswerPolicy';

/**
 * @param {{
 *   question: import('../types').ExamQuestion | null | undefined,
 *   questionIndex: number,
 *   selectedOption: import('../types').SelectedOption,
 *   setSelectedOption: (value: import('../types').SelectedOption) => void,
 *   handleAction: (action: import('../features/exam/useExamNavigation').ExamActionType) => void,
 *   goNext: () => void,
 *   goPrev: () => void,
 *   submitExam: () => void,
 *   submitButtonRef?: import('react').Ref<HTMLButtonElement>,
 *   isFirstQuestionOfExam: boolean,
 *   isLastQuestionOfExam: boolean | undefined,
 *   disabled?: boolean,
 *   totalQuestions?: number
 * }} props `totalQuestions` is passed by ActiveExamView but not currently used.
 */
const QuestionPanel = ({ 
  question, 
  questionIndex, 
  selectedOption, 
  setSelectedOption,
  handleAction,
  goNext,
  goPrev,
  submitExam,
  submitButtonRef,
  isFirstQuestionOfExam,
  isLastQuestionOfExam,
  disabled = false
}) => {
  const isNumericalQuestion = question?.type === 'NUMERICAL' || !question?.options || question.options.length === 0;
  const [numericalDraft, setNumericalDraft] = useState(() => selectedOption == null ? '' : String(selectedOption));
  const [numericalError, setNumericalError] = useState('');
  const draftQuestionIdRef = useRef(question?.id);

  useEffect(() => {
    const externalValue = selectedOption == null ? '' : String(selectedOption);
    if (draftQuestionIdRef.current !== question?.id) {
      draftQuestionIdRef.current = question?.id;
      setNumericalDraft(externalValue);
      setNumericalError('');
      return;
    }
    // Preserve a local transient draft such as "-" or ".", but accept server
    // reconciliation and external clearing whenever the current draft is valid.
    const currentDraft = validateNumericalAnswer(numericalDraft);
    if ((numericalDraft === '' || currentDraft.valid) && externalValue !== numericalDraft) {
      setNumericalDraft(externalValue);
      setNumericalError('');
    }
  }, [question?.id, selectedOption, numericalDraft]);

  /** @param {unknown} value */
  const applyNumericalDraft = (value) => {
    if (disabled) return;
    const next = String(value);
    const validation = validateNumericalAnswer(next);
    setNumericalDraft(next);
    setNumericalError(validation.error);
    // Incomplete or invalid drafts never replace the last valid autosave.
    // Emptying the field is an intentional clear; malformed/intermediate text
    // stays local until it becomes a complete valid decimal.
    if (validation.valid) setSelectedOption(next);
    else if (validation.empty) setSelectedOption(null);
  };

  const clearResponse = useCallback(() => {
    if (disabled) return;
    setNumericalDraft('');
    setNumericalError('');
    setSelectedOption(null);
  }, [disabled, setSelectedOption]);

  const numericalDraftIsReady = useCallback(() => {
    if (!isNumericalQuestion || numericalDraft === '') return true;
    const validation = validateNumericalAnswer(numericalDraft);
    if (!validation.valid) {
      setNumericalError(validation.error || 'Finish entering the numerical value.');
      return false;
    }
    return true;
  }, [isNumericalQuestion, numericalDraft]);

  const performAction = useCallback((/** @type {import('../features/exam/useExamNavigation').ExamActionType} */ action) => {
    if (numericalDraftIsReady()) handleAction(action);
  }, [handleAction, numericalDraftIsReady]);

  const performSubmit = () => {
    if (numericalDraftIsReady()) submitExam();
  };

  useEffect(() => {
    if (disabled) return;

    /** @param {KeyboardEvent} e */
    const handleGlobalKeyDown = (e) => {
      const activeTag = document.activeElement?.tagName?.toLowerCase();
      const isTyping = activeTag === 'input' || activeTag === 'textarea';

      // Alt+S or Ctrl+Enter: Save & Next
      if ((e.altKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && e.key === 'Enter')) {
        e.preventDefault();
        performAction('SAVE_NEXT');
        return;
      }

      // Alt+M: Save & Mark for Review
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        performAction('SAVE_MARK');
        return;
      }

      // Alt+C: Clear response
      if (e.altKey && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        clearResponse();
        return;
      }

      // Arrow navigation when not typing in numerical text input
      if (!isTyping) {
        if (e.key === 'ArrowRight' || (e.altKey && (e.key === 'n' || e.key === 'N'))) {
          if (!isLastQuestionOfExam) {
            e.preventDefault();
            goNext();
          }
        } else if (e.key === 'ArrowLeft' || (e.altKey && (e.key === 'p' || e.key === 'P'))) {
          if (!isFirstQuestionOfExam) {
            e.preventDefault();
            goPrev();
          }
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [disabled, performAction, clearResponse, goNext, goPrev, isFirstQuestionOfExam, isLastQuestionOfExam]);

  if (!question) return null;

  const isNumericalView = question.type === 'NUMERICAL' || !question.options || question.options.length === 0;
  // Question text, options, numerical input and keypad scale with the
  // candidate's text-size choice via --exam-text-scale (set by ActiveExamView).
  const keypadKey = 'h-12 rounded-lg border border-slate-200 bg-white p-0 text-[length:calc(var(--exam-text-scale,1)*1.125rem)] font-semibold text-slate-800 shadow-sm tabular-nums transition-colors hover:border-brand-300 hover:bg-brand-50 active:bg-brand-100 disabled:hover:bg-white';
  const shortcutHint = 'hidden text-xs font-medium lg:inline';

  return (
    <div className="exam-question-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, backgroundColor: 'var(--panel-bg)', borderRight: '1px solid var(--border-color)', position: 'relative' }}>
      {/* Hidden Skip Links for Keyboard & Screen Reader Users */}
      <div className="sr-skip-nav">
        <a href="#question-prompt-text" className="sr-skip-link">Skip to question prompt</a>
        <a href="#question-action-bar" className="sr-skip-link">Skip to action buttons</a>
      </div>

      {/* Question Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-slate-900">Question {questionIndex + 1}</h3>
          <Badge variant={isNumericalView ? 'warning' : 'brand'} className="uppercase tracking-wide">
            {isNumericalView ? <Hash aria-hidden="true" /> : <ListChecks aria-hidden="true" />}
            {isNumericalView ? 'NUMERICAL VALUE TYPE' : 'MULTIPLE CHOICE'}
          </Badge>
        </div>
      </div>

      {/* Question Content */}
      <div className="exam-question-content flex-1 overflow-y-auto px-5 py-5 sm:px-6">
        <p id="question-prompt-text" tabIndex={-1} className="mb-5 whitespace-pre-wrap break-words text-[length:calc(var(--exam-text-scale,1)*1rem)] leading-relaxed text-slate-900 sm:text-[length:calc(var(--exam-text-scale,1)*1.05rem)]"><MathRenderer text={question.text} /></p>

        {question.questionImageUrl && (
          <div className="mb-6">
            <StorageImage src={question.questionImageUrl} alt="Question context" className="max-h-[400px] max-w-full rounded-lg border border-slate-200 shadow-sm" />
          </div>
        )}

        {isNumericalView ? (
          <div className="mt-2 flex max-w-lg flex-col gap-5">
            <div className="flex gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-[length:calc(var(--exam-text-scale,1)*0.875rem)] leading-relaxed text-brand-900">
              <Info className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden="true" />
              <p>
                <strong className="font-semibold">Instructions:</strong> Enter an integer or decimal value (for example 5, -3.14, or 0.5). Scientific notation and spaces are not accepted. Values within {NUMERICAL_ABSOLUTE_TOLERANCE} of the answer are graded as correct.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor="numerical-answer" className="text-[length:calc(var(--exam-text-scale,1)*0.875rem)] font-semibold text-slate-800">Your Numerical Answer:</label>
              <Input
                id="numerical-answer"
                type="text"
                inputMode="decimal"
                placeholder="Enter numerical value..."
                disabled={disabled}
                maxLength={CANDIDATE_NUMERICAL_MAX_LENGTH}
                value={numericalDraft}
                aria-invalid={Boolean(numericalError)}
                aria-describedby="numerical-answer-help numerical-answer-error"
                onChange={(e) => {
                  applyNumericalDraft(e.target.value);
                }}
                className="h-auto min-h-14 border-2 border-brand-500 px-4 py-2 text-[length:calc(var(--exam-text-scale,1)*1.25rem)] font-semibold tabular-nums"
              />
              <span id="numerical-answer-help" className="text-xs text-slate-500">
                Maximum {CANDIDATE_NUMERICAL_MAX_LENGTH} characters; decimal notation only. An unfinished edit does not replace your last valid saved answer.
              </span>
              {numericalError && (
                <span id="numerical-answer-error" role="alert" className="flex items-center gap-1.5 text-sm font-semibold text-red-700">
                  <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
                  {numericalError}
                </span>
              )}
            </div>

            {/* Virtual Keypad for JEE/GATE feel */}
            <div className={cn('rounded-xl border border-slate-200 bg-slate-50 p-4 shadow-sm', disabled && 'pointer-events-none opacity-60')}>
              <div className="mb-3 flex items-center justify-between text-xs font-semibold text-slate-600">
                <span className="inline-flex items-center gap-1.5"><Keyboard className="size-4 text-slate-500" aria-hidden="true" /> Virtual Keypad</span>
                <span className="font-normal italic text-slate-500">Click or type directly</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, '.', 0, '-'].map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      const currentStr = numericalDraft;
                      if (key === '-' && currentStr.startsWith('-')) {
                        applyNumericalDraft(currentStr.substring(1));
                      } else if (key === '-' && !currentStr.startsWith('-')) {
                        applyNumericalDraft('-' + currentStr);
                      } else if (key === '.' && currentStr.includes('.')) {
                        // ignore double decimal
                      } else {
                        applyNumericalDraft(currentStr + key);
                      }
                    }}
                    className={keypadKey}
                  >
                    {key}
                  </button>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    const currentStr = numericalDraft;
                    const newStr = currentStr.slice(0, -1);
                    applyNumericalDraft(newStr);
                  }}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 text-sm font-semibold text-red-700 transition-colors hover:bg-red-100"
                >
                  <Delete className="size-4" aria-hidden="true" /> Backspace
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={clearResponse}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-100"
                >
                  <Eraser className="size-4" aria-hidden="true" /> Clear All
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="question-prompt-text"
            className={cn('flex flex-col gap-3', disabled && 'opacity-60')}
          >
            {/** @type {string[]} */ (question.options).map((opt, idx) => {
              const isSelected = selectedOption === idx;
              return (
                <label
                  key={idx}
                  className={cn(
                    'question-option-card group flex min-h-12 items-center gap-4 rounded-xl border-2 px-4 py-3 transition-colors',
                    disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                    isSelected
                      ? 'border-brand-500 bg-brand-50/70 shadow-sm'
                      : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50'
                  )}
                >
                  <input
                    type="radio"
                    name={`q-${question.id}`}
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => !disabled && setSelectedOption(idx)}
                    onKeyDown={(e) => {
                      if (disabled) return;
                      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        const next = (idx + 1) % /** @type {string[]} */ (question.options).length;
                        setSelectedOption(next);
                      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                        e.preventDefault();
                        const prev = (idx - 1 + /** @type {string[]} */ (question.options).length) % /** @type {string[]} */ (question.options).length;
                        setSelectedOption(prev);
                      }
                    }}
                    className={cn('size-5 shrink-0 accent-brand-600', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}
                  />
                  <div className="flex min-w-0 flex-col gap-2">
                    <span className="flex items-start gap-3 whitespace-pre-wrap break-words text-[length:calc(var(--exam-text-scale,1)*1rem)] text-slate-800">
                      <strong
                        className={cn(
                          'inline-flex h-7 min-w-8 shrink-0 items-center justify-center rounded-full px-2 text-sm font-semibold',
                          isSelected ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 group-hover:bg-brand-100 group-hover:text-brand-700'
                        )}
                      >
                        {String.fromCharCode(65 + idx)}.
                      </strong>{' '}
                      <span className="min-w-0 pt-0.5"><MathRenderer text={opt} /></span>
                    </span>
                    {question.optionImageUrls && question.optionImageUrls[idx] && (
                      <StorageImage src={question.optionImageUrls[idx]} alt={`Option ${String.fromCharCode(65 + idx)}`} className="mt-1 max-h-[200px] max-w-full self-start rounded-md border border-slate-200" />
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Sticky Bottom Action Bar */}
      <div id="question-action-bar" className="exam-action-bar max-[900px]:[&_button]:min-h-11 border-t border-slate-200 bg-slate-50 px-5 py-3 [&>.exam-navigation-actions]:flex [&>.exam-navigation-actions]:items-center [&>.exam-navigation-actions]:justify-between [&>.exam-navigation-actions]:gap-2 [&>.exam-navigation-actions]:border-t [&>.exam-navigation-actions]:border-slate-200 [&>.exam-navigation-actions]:pt-3">
        <div className="exam-answer-actions mb-3 flex flex-wrap gap-2 max-[600px]:grid max-[600px]:grid-cols-2 max-[600px]:[&_button]:h-auto max-[600px]:[&_button]:whitespace-normal max-[600px]:[&_button]:py-2 max-[600px]:[&_button]:text-center max-[600px]:[&_button]:leading-tight">
          <Button variant="success" disabled={disabled} onClick={() => performAction('SAVE_NEXT')} title="Save response and advance (Alt+S or Ctrl+Enter)">
            <Save aria-hidden="true" />Save & Next <span aria-hidden="true" className={shortcutHint}>(Alt+S)</span>
          </Button>
          <Button variant="warning" disabled={disabled} onClick={() => performAction('SAVE_MARK')} title="Save response and mark for review (Alt+M)">
            <BookmarkCheck aria-hidden="true" />Save & Mark for Review <span aria-hidden="true" className={shortcutHint}>(Alt+M)</span>
          </Button>
          <Button variant="secondary" disabled={disabled} onClick={clearResponse} title="Clear response for this question (Alt+C)">
            <Eraser aria-hidden="true" />Clear Response <span aria-hidden="true" className={shortcutHint}>(Alt+C)</span>
          </Button>
          <Button variant="violet" disabled={disabled} onClick={() => performAction('MARK_NEXT')} title="Mark for review without saving response">
            <Flag aria-hidden="true" />Mark for Review & Next
          </Button>
        </div>

        <div className="exam-navigation-actions">
          <Button variant="secondary" onClick={goPrev} disabled={isFirstQuestionOfExam} title="Previous question (Alt+P or ArrowLeft)">
            <ChevronLeft aria-hidden="true" />Back
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={goNext} disabled={isLastQuestionOfExam} title="Next question (Alt+N or ArrowRight)">
              Next<ChevronRight aria-hidden="true" />
            </Button>
            <Button ref={submitButtonRef} variant="primary" onClick={performSubmit}>
              <Send aria-hidden="true" />Submit Exam
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoized: the exam session passes stable callbacks, so autosave-status and
// other unrelated session updates no longer re-render the question.
export default memo(QuestionPanel);
