// The ACTIVE exam screen. All state lives in useExamSession; this component
// only lays it out. It is imported statically by App so the safety-critical
// OfflineOverlay is already bundled before the connection can be lost.
import { lazy, useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, LayoutGrid, RefreshCw, Send, ShieldCheck, Signal, TimerOff, WifiOff } from 'lucide-react';
import { Button } from '../../components/ui';
import OfflineOverlay from '../../components/OfflineOverlay';
import { useExamTextSize } from './useExamTextSize';
import { EXAM_NARROW_QUERY, useMediaQuery } from './useMediaQuery';

const ExamNavbar = lazy(() => import('../../components/ExamNavbar'));
const QuestionPanel = lazy(() => import('../../components/QuestionPanel'));
const GridPanel = lazy(() => import('../../components/GridPanel'));
const AccessibleModal = lazy(() => import('../../components/AccessibleModal'));
const QuestionPaletteSheet = lazy(() => import('./QuestionPaletteSheet'));

const WATERMARK_SLOTS = Array.from({ length: 12 }, (_, index) => index);

/**
 * @param {{
 *   session: ReturnType<typeof import('./useExamSession').useExamSession>,
 *   currentStudent: import('./examSessionHelpers').CurrentStudent | null
 * }} props
 */
export default function ActiveExamView({ session, currentStudent }) {
  const {
    activeExam,
    examData,
    activeSubject,
    autosaveStatus,
    recoveryNotice,
    setRecoveryNotice,
    localRecoveryAvailable,
    offlineSince,
    offlineDismissed,
    setOfflineDismissed,
    sessionEndTime,
    isExamLocked,
    studentSessionLocked,
    lockdownActive,
    handleReturnToExam,
    showSubmitModal,
    setShowSubmitModal,
    submitButtonRef,
    submissionError,
    isSubmitting,
    submitExam,
    confirmSubmitExam,
    terminateExam,
    handleSafeLogout,
    currentQIndex,
    currentQuestion,
    currentResponse,
    totalSubQuestions,
    isFirstQuestionOfExam,
    isLastQuestionOfExam,
    questionStatuses,
    setSelectedOption,
    handleAction,
    goNext,
    goPrev,
    changeQuestion,
    handleSubjectChange
  } = session;

  // Text size and the narrow-layout palette are view-only state: they never
  // touch the session, and the memoized panels do not re-render for them.
  const { textSize, setTextSize, textScale } = useExamTextSize(currentStudent?.id);
  const isNarrowLayout = useMediaQuery(EXAM_NARROW_QUERY);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const answeredCount = useMemo(
    () => questionStatuses.filter(status => status === 'ANSWERED' || status === 'ANSWERED_MARKED').length,
    [questionStatuses]
  );
  const contentStyle = useMemo(() => /** @type {import('react').CSSProperties} */ ({
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    '--exam-text-scale': String(textScale)
  }), [textScale]);

  const gridPanel = (
    <GridPanel
      totalQuestions={totalSubQuestions}
      questionStatuses={questionStatuses}
      currentQuestionIndex={currentQIndex}
      setCurrentQuestionIndex={changeQuestion}
    />
  );

  return (
    <div className="active-exam-shell flex h-dvh flex-col overflow-hidden bg-slate-100">
      <div className="exam-candidate-watermark" aria-hidden="true">
        {WATERMARK_SLOTS.map((index) => (
          <span key={index}>{currentStudent?.id || 'Candidate'} · Secure exam</span>
        ))}
      </div>
      {offlineSince && !offlineDismissed && (
        <OfflineOverlay
          offlineSince={offlineSince}
          onTerminate={terminateExam}
          onLogout={() => handleSafeLogout({ preserveAttempt: true })}
          onContinueOffline={() => setOfflineDismissed(true)}
          recoveryAvailable={localRecoveryAvailable}
        />
      )}
      {offlineSince && offlineDismissed && (
        <div className="theme-island z-[100] flex flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-red-700 px-4 py-2 text-center text-sm font-semibold text-white shadow-md">
          <span className="inline-flex items-center gap-2">{localRecoveryAvailable
            ? <><WifiOff className="size-4 shrink-0" aria-hidden="true" /> Offline Mode Active: You can continue answering. Responses are being saved on this device.</>
            : <><AlertTriangle className="size-4 shrink-0" aria-hidden="true" /> Offline recovery storage failed. Reconnect immediately and keep this page open.</>}</span>
          <button
            onClick={() => setOfflineDismissed(false)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/60 bg-white/15 px-2.5 py-0 text-xs font-semibold text-white hover:bg-white/25"
          >
            <Signal className="size-3.5" aria-hidden="true" />
            Network Status
          </button>
        </div>
      )}
      {lockdownActive && (
        <div
          role="alert"
          aria-live="assertive"
          className="exam-security-cover"
          onPointerDown={handleReturnToExam}
        >
          <div className="exam-security-spinner" aria-hidden="true" />
          <span className="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
            <ShieldCheck className="size-5 text-brand-300" aria-hidden="true" />
            Restoring secure examination view…
          </span>
        </div>
      )}
      {showSubmitModal && (
        <AccessibleModal labelledBy="submit-exam-title" onEscape={() => !isSubmitting && setShowSubmitModal(false)} returnFocusRef={submitButtonRef} maxWidth="400px">
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-full bg-brand-50 text-brand-600 ring-8 ring-brand-50/60">
            <Send className="size-6" aria-hidden="true" />
          </div>
          <h2 id="submit-exam-title" className="mb-2 text-xl font-semibold tracking-tight text-slate-900">Submit Exam?</h2>
          <p className="mb-6 text-sm leading-relaxed text-slate-600">Are you sure you want to submit your exam? You will not be able to change your answers.</p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row">
            <Button data-modal-autofocus variant="secondary" size="lg" className="flex-1" onClick={() => setShowSubmitModal(false)}>
              Cancel
            </Button>
            <Button variant="success" size="lg" className="flex-1" onClick={confirmSubmitExam} disabled={isSubmitting || studentSessionLocked}>
              {isSubmitting ? 'Submitting…' : <><CheckCircle2 aria-hidden="true" />Yes, Submit</>}
            </Button>
          </div>
        </AccessibleModal>
      )}

      {submissionError && (
        <div className="fixed left-1/2 top-20 z-[10001] flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 shadow-2xl sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2 text-sm font-semibold text-red-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" /> {submissionError}
          </div>
          <Button
            variant="danger"
            onClick={confirmSubmitExam}
            disabled={isSubmitting || studentSessionLocked}
            className="shrink-0"
          >
            {isSubmitting ? 'Submitting...' : <><RefreshCw aria-hidden="true" /> Retry Submit Exam</>}
          </Button>
        </div>
      )}

      {recoveryNotice && (
        <div role="status" className="z-[101] flex flex-wrap items-center justify-center gap-x-3 gap-y-2 bg-amber-50 px-4 py-2.5 text-center text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden="true" /> {recoveryNotice}
          <button type="button" onClick={() => setRecoveryNotice('')} className="h-7 rounded-md border border-amber-300 bg-white px-2.5 py-0 text-xs font-semibold text-amber-900 hover:bg-amber-100">Dismiss</button>
        </div>
      )}

      {isExamLocked && (
        <div className="z-[100] flex items-center justify-center gap-3 bg-rose-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-md">
          <TimerOff className="size-4 shrink-0" aria-hidden="true" />
          <span>Examination Time Has Concluded. Answers are locked. Submitting responses to server...</span>
        </div>
      )}

      {/* The countdown ticks inside ExamNavbar (subscribed to the shared exam
          clock); this tree re-renders only when session state changes. */}
      <ExamNavbar
        subjects={/** @type {string[]} */ (examData.subjects)}
        activeSubject={activeSubject}
        setActiveSubject={handleSubjectChange}
        studentName={currentStudent?.name}
        examTitle={activeExam?.title}
        paused={false}
        endTime={sessionEndTime}
        autosaveStatus={autosaveStatus}
        textSize={textSize}
        onTextSizeChange={setTextSize}
      />
      {isNarrowLayout && (
        <div className="exam-palette-toolbar flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 py-2">
          <div className="flex min-w-0 items-center gap-2 text-sm text-slate-600">
            <span className="truncate font-semibold text-slate-900 tabular-nums">Q {currentQIndex + 1} / {totalSubQuestions}</span>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="status-answered flex h-6 min-w-6 items-center justify-center rounded-md px-1 text-xs font-bold tabular-nums" aria-hidden="true">{answeredCount}</span>
              <span aria-hidden="true">answered</span>
              <span className="sr-only">{answeredCount} of {totalSubQuestions} answered in this section</span>
            </span>
          </div>
          <Button
            ref={paletteButtonRef}
            variant="secondary"
            className="min-h-11 shrink-0"
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            onClick={() => setPaletteOpen(true)}
          >
            <LayoutGrid aria-hidden="true" /> Questions
          </Button>
        </div>
      )}
      {isNarrowLayout && paletteOpen && (
        <QuestionPaletteSheet onClose={closePalette} subject={activeSubject} returnFocusRef={paletteButtonRef}>
          {gridPanel}
        </QuestionPaletteSheet>
      )}
      <div className="active-exam-content" style={contentStyle}>
        <QuestionPanel
          question={currentQuestion}
          questionIndex={currentQIndex}
          selectedOption={currentResponse.selectedOption}
          setSelectedOption={setSelectedOption}
          handleAction={handleAction}
          totalQuestions={totalSubQuestions}
          goNext={goNext}
          goPrev={goPrev}
          submitExam={submitExam}
          submitButtonRef={submitButtonRef}
          isFirstQuestionOfExam={isFirstQuestionOfExam}
          isLastQuestionOfExam={isLastQuestionOfExam}
          disabled={isExamLocked || studentSessionLocked}
        />
        {!isNarrowLayout && gridPanel}
      </div>
    </div>
  );
}
