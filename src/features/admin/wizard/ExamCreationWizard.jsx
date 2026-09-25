import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Layers, Loader2, X } from 'lucide-react';
import { Button, cn } from '../../../components/ui';
import { useDialogFocusTrap } from '../../../dialogFocus';
import { useAdminContext } from '../adminContext';
import { useClassesOnDemand } from '../classes/useClasses';
import { useWizardQuestionBrowser } from './useWizardQuestionBrowser';
import {
  WIZARD_STEPS, summarizeSelection, validateDetailsStep, validateMarkingStep, validateQuestionsStep
} from './wizardLogic';
import DetailsStep from './DetailsStep';
import QuestionsStep from './QuestionsStep';
import MarkingStep from './MarkingStep';
import ReviewStep from './ReviewStep';

/**
 * @typedef {object} ExamCreationWizardProps
 * @property {import('../questions/useExamBuilder').ExamBuilder} examBuilder
 * @property {string[]} selectedQuestions
 * @property {import('react').Dispatch<import('react').SetStateAction<string[]>>} setSelectedQuestions
 * @property {Record<string, string>} [initialSubjectsById] Subjects of questions already seen (e.g. on the Question Bank screen).
 * @property {() => void} onClose
 */

/**
 * Step-by-step exam creation: Details, Questions, Marking & timing, Review.
 * A modal dialog on top of the current screen. The final Create action is the
 * builder's normal create path (server verification, pattern re-check, insert).
 * @param {ExamCreationWizardProps} props
 */
export default function ExamCreationWizard({ examBuilder, selectedQuestions, setSelectedQuestions, initialSubjectsById, onClose }) {
  const { classBook, catalog, dataLoadState } = useAdminContext();
  useClassesOnDemand(true);
  const [stepIndex, setStepIndex] = useState(0);
  const [attempted, setAttempted] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [reviewReady, setReviewReady] = useState(false);
  const [subjectsById, setSubjectsById] = useState(() => /** @type {Record<string, string>} */ ({ ...(initialSubjectsById || {}) }));
  const headingRef = useRef(/** @type {HTMLHeadingElement | null} */ (null));
  const firstRenderRef = useRef(true);

  const closeFromEscape = () => {
    // Ignore Escape pressed inside a notification dialog shown on top of the wizard.
    if (dialogRef.current && dialogRef.current.contains(document.activeElement)) onClose();
  };
  const { dialogRef, handleDialogKeyDown } = useDialogFocusTrap({ onEscape: closeFromEscape });

  const browser = useWizardQuestionBrowser({
    enabled: WIZARD_STEPS[stepIndex].id === 'questions',
    onRowsLoaded: useCallback((/** @type {import('../../../types').QuestionBankItem[]} */ rows) => {
      setSubjectsById(previous => {
        const next = { ...previous };
        rows.forEach(row => { if (row.docId) next[row.docId] = row.subject; });
        return next;
      });
    }, [])
  });

  const template = /** @type {import('../../../types').PatternTemplate | null} */ (examBuilder.selectedTemplate);
  const summary = summarizeSelection({
    selectedIds: selectedQuestions,
    subjectsById,
    marksCorrect: examBuilder.examMarksCorrect,
    template,
    compareSubjects: catalog.compareSubjects
  });
  const detailErrors = validateDetailsStep({ title: examBuilder.newExamTitle, targetClass: examBuilder.examTargetClass, targetSection: examBuilder.examTargetSection });
  const questionProblems = validateQuestionsStep({ selectedCount: selectedQuestions.length, patternCheck: summary.patternCheck });
  const markingProblems = validateMarkingStep({ duration: examBuilder.examDuration, marksCorrect: examBuilder.examMarksCorrect, marksIncorrect: examBuilder.examMarksIncorrect });
  const stepValid = [Object.keys(detailErrors).length === 0, questionProblems.length === 0, markingProblems.length === 0, reviewReady];
  // A step can be opened once every step before it is valid.
  const reachable = WIZARD_STEPS.map((_, index) => stepValid.slice(0, index).every(Boolean));
  const step = WIZARD_STEPS[stepIndex];

  // Move focus to the step heading whenever the step changes (not on open:
  // the dialog focuses the first field).
  useEffect(() => {
    if (firstRenderRef.current) { firstRenderRef.current = false; return; }
    headingRef.current?.focus();
  }, [stepIndex]);

  const goTo = (/** @type {number} */ index) => {
    if (index < 0 || index >= WIZARD_STEPS.length || !reachable[index]) return;
    setStepIndex(index);
  };

  const handleNext = () => {
    setAttempted(previous => ({ ...previous, [step.id]: true }));
    if (!stepValid[stepIndex]) {
      // Focus the first field with a problem so it is announced and can be fixed.
      requestAnimationFrame(() => {
        const invalid = /** @type {HTMLElement | null} */ (dialogRef.current?.querySelector('[aria-invalid="true"], [role="alert"]'));
        if (invalid) {
          if (invalid.getAttribute('role') === 'alert') invalid.setAttribute('tabindex', '-1');
          invalid.focus();
        }
      });
      return;
    }
    setStepIndex(index => Math.min(index + 1, WIZARD_STEPS.length - 1));
  };

  const handleCreate = async () => {
    if (!reviewReady || examBuilder.isCreatingExam) return;
    await examBuilder.handleCreateExamFromSelected();
  };

  const isLastStep = stepIndex === WIZARD_STEPS.length - 1;

  return (
    <div
      ref={/** @type {import('react').RefObject<HTMLDivElement>} */ (dialogRef)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="exam-wizard-title"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      className="exam-creation-wizard fixed inset-0 z-50 flex items-stretch justify-center bg-slate-950/60 backdrop-blur-sm sm:p-4"
    >
      <div className="animate-fade-in flex h-full w-full max-w-6xl flex-col overflow-hidden bg-white shadow-2xl sm:rounded-2xl sm:border sm:border-slate-200">
        <header className="flex flex-col gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="exam-wizard-title" className="text-lg font-semibold tracking-tight text-slate-900">Create exam</h2>
              <p className="text-sm text-slate-500">Step {stepIndex + 1} of {WIZARD_STEPS.length}: {step.label}</p>
            </div>
            <Button variant="ghost" size="icon" className="size-10" aria-label="Close exam creation" onClick={onClose}>
              <X aria-hidden="true" />
            </Button>
          </div>
          <nav aria-label="Exam creation steps">
            <ol className="grid grid-cols-4 gap-2">
              {WIZARD_STEPS.map((item, index) => {
                const current = index === stepIndex;
                const done = index < stepIndex && stepValid[index];
                return (
                  <li key={item.id} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => goTo(index)}
                      disabled={!reachable[index]}
                      aria-current={current ? 'step' : undefined}
                      className={cn('flex w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed sm:px-3',
                        current ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-60 disabled:hover:bg-white')}
                    >
                      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums',
                        current ? 'bg-brand-600 text-white' : done ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600')}>
                        {done ? <Check className="size-4" aria-hidden="true" /> : index + 1}
                      </span>
                      <span className="hidden min-w-0 sm:block">
                        <span className="block truncate text-sm font-semibold text-slate-900">{item.label}</span>
                        <span className="block truncate text-xs text-slate-500">{item.description}</span>
                      </span>
                      <span className="sr-only sm:hidden">{item.label}</span>
                      {done && <span className="sr-only"> (complete)</span>}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <h3 ref={headingRef} tabIndex={-1} className="mb-4 text-base font-semibold text-slate-900 focus:outline-none">
            {step.label}
            <span className="ml-2 text-sm font-normal text-slate-500">{step.description}</span>
          </h3>
          {step.id === 'details' && (
            <DetailsStep
              examBuilder={examBuilder}
              classes={classBook.classes}
              classesLoading={Boolean(dataLoadState.classes?.loading)}
              errors={detailErrors}
              showErrors={Boolean(attempted.details)}
            />
          )}
          {step.id === 'questions' && (
            <QuestionsStep
              examBuilder={examBuilder}
              selectedQuestions={selectedQuestions}
              setSelectedQuestions={setSelectedQuestions}
              browser={browser}
              summary={summary}
              subjectCatalog={catalog.subjectCatalog}
              problems={questionProblems}
              showErrors={Boolean(attempted.questions)}
            />
          )}
          {step.id === 'marking' && (
            <MarkingStep examBuilder={examBuilder} summary={summary} problems={markingProblems} showErrors={Boolean(attempted.marking) || markingProblems.length > 0} />
          )}
          {step.id === 'review' && (
            <ReviewStep examBuilder={examBuilder} selectedQuestions={selectedQuestions} catalog={catalog} onReadyChange={setReviewReady} />
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:px-6">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <div className="flex flex-wrap gap-2">
            {stepIndex > 0 && (
              <Button variant="secondary" onClick={() => goTo(stepIndex - 1)}>
                <ArrowLeft aria-hidden="true" /> Back
              </Button>
            )}
            {isLastStep ? (
              <Button variant="success" onClick={handleCreate} disabled={!reviewReady || examBuilder.isCreatingExam}>
                {examBuilder.isCreatingExam ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Layers aria-hidden="true" />}
                {examBuilder.isCreatingExam ? 'Creating…' : 'Create exam'}
              </Button>
            ) : (
              <Button onClick={handleNext}>
                Next: {WIZARD_STEPS[stepIndex + 1].label} <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
