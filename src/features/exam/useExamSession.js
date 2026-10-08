/// <reference path="./browserApis.d.ts" />
// Student exam session: start/resume, versioned autosave with offline
// recovery, takeover detection, lockdown violations, subject timing, and the
// submit/terminate flows. App.jsx owns only routing state and passes it in.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { APP_ERROR, classifyAppError } from '../../appErrors';
import { supabase, supabaseUrl, supabaseAnonKey } from '../../supabase';
import { customAlert } from '../../utils';
import { safeStorageSet, safeStorageRemove } from '../../browserStorage';
import {
  createInitialResponses,
  sessionBelongsToStudent,
  saveOfflineRecoveryRecord,
  readOfflineRecoveryRecord,
  clearOfflineRecoveryRecord,
  reconcileOfflineRecovery,
  savePendingSubmissionRecord,
  readPendingSubmissionRecord,
  beginPendingSubmissionSync,
  finishPendingSubmissionSync,
  savePendingTerminationRecord,
  readPendingTerminationRecord,
  clearPendingTerminationRecord,
  sameResponses,
  isTransientRpcError,
  retryDelayMs
} from '../../examLogic';
import { createExamSavePipeline } from '../../examSavePipeline';
import { useStudentPolling } from './useStudentPolling';
import { announceAssertive } from '../../components/LiveAnnouncer';
import {
  emptyExam,
  readStoredSessionMirror,
  isStudentSessionReplaced,
  examActionErrorMessage,
  committedResultToScorecard,
  shuffleQuestionBlocks
} from './examSessionHelpers';
import { anchorExamClock, getExamActionNow, resetExamClock, useDeadlineReached } from './examClock';
import { useExamLockdown } from './useExamLockdown';
import { useSubjectTime } from './useSubjectTime';
import { useExamNavigation } from './useExamNavigation';

/**
 * @typedef {import('../../types').ExamPaper} ExamPaper
 * @typedef {import('../../types').ExamResponses} ExamResponses
 * @typedef {import('../../types').CurrentIndices} CurrentIndices
 * @typedef {import('../../types').QuestionResponse} QuestionResponse
 * @typedef {import('./examSessionHelpers').CurrentStudent} CurrentStudent
 * @typedef {import('./examSessionHelpers').ActiveExam} ActiveExam
 * @typedef {import('./examSessionHelpers').Scorecard} Scorecard
 * @typedef {{ preserveAttempt?: boolean }} SafeLogoutOptions
 * @typedef {import('./examSessionHelpers').TerminationReason} TerminationReason
 * @typedef {'SAVED' | 'SAVING' | 'RETRYING' | 'OFFLINE' | 'FAILED' | 'LOCKED' | 'CONFLICT'} AutosaveStatus
 * @typedef {import('../../types').ActiveExamSessionMirror & {
 *   subjectTimeSeconds?: Record<string, number>
 * }} InitialActiveSession Stored session mirror restored on reload.
 */

/** @type {QuestionResponse} */
const NOT_VISITED_RESPONSE = { selectedOption: null, status: 'NOT_VISITED' };

// How long "Ending your exam…" waits for the server before recording the
// termination for a later retry and showing the terminated screen anyway.
const TERMINATE_REQUEST_TIMEOUT_MS = 10_000;

/**
 * @template T
 * @param {PromiseLike<T>} request
 * @param {number} ms
 * @returns {Promise<T>}
 */
const withTimeout = (request, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('The request timed out.')), ms);
  Promise.resolve(request).then(
    value => { clearTimeout(timer); resolve(value); },
    error => { clearTimeout(timer); reject(error); }
  );
});

/**
 * @param {{
 *   examState: string,
 *   setExamState: (state: string) => void,
 *   currentStudent: CurrentStudent | null,
 *   setCurrentStudent: (student: CurrentStudent | null) => void,
 *   setResults: (results: Scorecard) => void,
 *   initialActiveSession: InitialActiveSession | null
 * }} options
 */
export function useExamSession({ examState, setExamState, currentStudent, setCurrentStudent, setResults, initialActiveSession }) {
  const [activeExam, setActiveExam] = useState(/** @returns {ActiveExam | null} */ () => initialActiveSession?.activeExam || null);
  const [examData, setExamData] = useState(/** @returns {ExamPaper} */ () => initialActiveSession?.examData || emptyExam);
  const [activeSubject, setActiveSubject] = useState(() => initialActiveSession?.activeSubject || '');
  const [currentIndices, setCurrentIndices] = useState(/** @returns {CurrentIndices} */ () => initialActiveSession?.currentIndices || {});
  const [userResponses, setUserResponses] = useState(/** @returns {ExamResponses} */ () => /** @type {ExamResponses | undefined} */ (initialActiveSession?.userResponses) || {});
  const [offlineSince, setOfflineSince] = useState(/** @type {number | null} */ (null));
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const submitButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  // The fixed deadline is mirrored in state (for the clock subscription) and in
  // a ref (for async flows that must read the latest value synchronously).
  const [sessionEndTime, setSessionEndTime] = useState(/** @returns {number | null} */ () => initialActiveSession?.endTime || null);
  const sessionEndTimeRef = useRef(/** @type {number | null} */ (initialActiveSession?.endTime || null));
  const [submissionError, setSubmissionError] = useState(/** @type {string | null} */ (null));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionStartedRef = useRef(false);
  const confirmedSubmissionVersionRef = useRef(/** @type {number | null} */ (null));
  const [autosaveStatus, setAutosaveStatus] = useState(/** @type {AutosaveStatus} */ ('SAVED'));
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [localRecoveryAvailable, setLocalRecoveryAvailable] = useState(true);
  const sessionVersionRef = useRef(initialActiveSession?.version || 1);
  const isSavingRef = useRef(false);
  // Last answer set the server confirmed. Navigation-only changes are persisted
  // locally but never re-sent, which removes most redundant autosave writes.
  const lastConfirmedResponsesRef = useRef(/** @type {ExamResponses | null} */ (null));
  const [runtimeStatus, setRuntimeStatus] = useState('PENDING');
  const [runtimeError, setRuntimeError] = useState('');
  const responsesRef = useRef(userResponses);
  useEffect(() => { responsesRef.current = userResponses; }, [userResponses]);
  const safeLogoutRef = useRef(/** @type {((options?: SafeLogoutOptions) => void) | null} */ (null));
  const studentSessionLockedRef = useRef(false);
  const [studentSessionLocked, setStudentSessionLocked] = useState(false);
  const [accessGeneration, setAccessGeneration] = useState(/** @type {number | null} */ (initialActiveSession?.accessGeneration ?? null));
  const accessGenerationRef = useRef(/** @type {number | null} */ (initialActiveSession?.accessGeneration ?? null));
  const authAccessTokenRef = useRef(/** @type {string | null} */ (null));
  const terminateExamRef = useRef(/** @type {((reason?: TerminationReason) => Promise<void>) | undefined} */ (undefined));
  // Termination waits for the server before the "Exam Terminated" screen, so a
  // quick return to the dashboard never shows the attempt as still open.
  const terminatingRef = useRef(false);
  const [isTerminating, setIsTerminating] = useState(false);
  const [terminationReason, setTerminationReason] = useState(/** @type {TerminationReason | null} */ (null));
  const confirmSubmitExamRef = useRef(/** @type {(() => Promise<void>) | undefined} */ (undefined));

  const {
    warningsRef,
    isAlertingRef,
    lockdownActiveRef,
    lockdownActive,
    warning,
    clearLockdown,
    handleReturnToExam
  } = useExamLockdown({
    active: examState === 'ACTIVE',
    terminateExamRef,
    warningScope: { student: currentStudent, examId: activeExam?.id }
  });

  // Only the transition to "deadline reached" re-renders the session; the
  // per-second countdown text is rendered by ExamNavbar's own clock subscriber.
  const isExamLocked = useDeadlineReached(sessionEndTime, examState === 'ACTIVE');

  const { subjectTimeRef, subjectTickRef, syncSubjectTime, getSubjectTimeSnapshot, markSubjectTimeSaved, timingInFlightRef } = useSubjectTime({
    examState,
    activeSubject,
    activeExamId: activeExam?.id,
    currentStudent,
    lockdownActiveRef,
    initialSubjectTimeSeconds: initialActiveSession?.subjectTimeSeconds,
    accessGenerationRef,
    answerSavingRef: isSavingRef
  });

  const flushPendingTermination = useCallback(async () => {
    if (!currentStudent) return;
    const pending = readPendingTerminationRecord({ student: currentStudent, userUuid: currentStudent.docId });
    if (!pending) return;
    try {
      const { data, error } = await supabase.rpc('terminate_exam', {
        exam_id_param: pending.examId,
        reason_param: pending.reason || 'SECURITY_VIOLATION',
        access_generation_param: pending.accessGeneration ?? null
      });
      if (error) throw error;
      if (!data?.stale_generation) clearOfflineRecoveryRecord({ student: currentStudent, examId: pending.examId, userUuid: currentStudent.docId });
      clearPendingTerminationRecord({ student: currentStudent, userUuid: currentStudent.docId });
    } catch (err) {
      console.error('Pending termination retry failed:', err);
      if (isStudentSessionReplaced(err)) {
        studentSessionLockedRef.current = true;
        setStudentSessionLocked(true);
        safeLogoutRef.current?.({ preserveAttempt: true });
      }
    }
  }, [currentStudent]);

  const flushPendingOfflineSubmission = useCallback(async () => {
    if (!currentStudent || submissionStartedRef.current || terminatingRef.current) return;
    const parsed = readPendingSubmissionRecord({
      student: currentStudent,
      examId: activeExam?.id,
      userUuid: currentStudent.docId
    });
    if (!parsed) return;
    const examId = parsed.examId;
    if (!beginPendingSubmissionSync({ student: currentStudent, examId, userUuid: currentStudent.docId })) return;

    try {
      setIsSubmitting(true);
      submissionStartedRef.current = true;
      setSubmissionError('Finalizing previously confirmed answers...');
      const { data: finalResults, error } = await supabase.rpc('submit_exam', {
        exam_id_param: examId,
        responses_param: null,
        ...(parsed.expectedVersion != null ? { expected_version_param: parsed.expectedVersion } : {}),
        access_generation_param: parsed.accessGeneration ?? null
      });
      if (error) {
        if (classifyAppError(error) === APP_ERROR.ALREADY_SUBMITTED) {
          const { data: committedResult } = await supabase
            .from('student_results')
            .select('*')
            .eq('student_id', currentStudent.id)
            .eq('exam_id', examId)
            .single();
          if (committedResult) {
            clearOfflineRecoveryRecord({ student: currentStudent, examId, userUuid: currentStudent.docId });
            setResults(committedResultToScorecard(committedResult));
            setExamState('SUBMITTED');
            setSubmissionError(null);
            if (document.fullscreenElement) {
              document.exitFullscreen().catch(() => {});
            }
            return;
          }
        }
        throw error;
      }
      clearOfflineRecoveryRecord({ student: currentStudent, examId, userUuid: currentStudent.docId });
      setResults(finalResults);
      setExamState('SUBMITTED');
      setSubmissionError(null);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    } catch (err) {
      console.error('Pending submission retry failed:', err);
      setSubmissionError(examActionErrorMessage(err, 'submit'));
      if (isStudentSessionReplaced(err)) {
        studentSessionLockedRef.current = true;
        setStudentSessionLocked(true);
        safeLogoutRef.current?.({ preserveAttempt: true });
      }
    } finally {
      setIsSubmitting(false);
      submissionStartedRef.current = false;
      finishPendingSubmissionSync({ student: currentStudent, examId, userUuid: currentStudent.docId });
    }
  }, [activeExam, currentStudent, setExamState, setResults]);

  // Offline tracking and auto-sync on reconnect
  useEffect(() => {
    const handleOnline = async () => {
      setOfflineSince(null);
      setOfflineDismissed(false);
      await flushPendingTermination();
      flushPendingOfflineSubmission();
    };
    const handleOffline = () => setOfflineSince(Date.now());

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (navigator.onLine === false) {
      setOfflineSince(Date.now());
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [flushPendingOfflineSubmission, flushPendingTermination]);

  useEffect(() => {
    if (currentStudent && navigator.onLine !== false) {
      const flushInOutcomeOrder = async () => {
        await flushPendingTermination();
        await flushPendingOfflineSubmission();
      };
      flushInOutcomeOrder();
    }
  }, [currentStudent, flushPendingTermination, flushPendingOfflineSubmission]);

  const handleSafeLogout = useCallback((/** @type {SafeLogoutOptions} */ options = {}) => {
    const preserveAttempt = options?.preserveAttempt === true;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error(err));
    }
    if (!preserveAttempt) safeStorageRemove('localStorage', 'cbt_active_exam_session');
    safeStorageRemove('localStorage', 'examSessionToken');
    safeStorageRemove('sessionStorage', 'currentStudent');
    safeStorageSet('sessionStorage', 'examState', 'AUTH');
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let releaseTimeout;
    Promise.race([
      Promise.resolve(supabase.rpc('release_student_session')).catch(() => null),
      new Promise(resolve => {
        releaseTimeout = setTimeout(resolve, 1500);
      })
    ]).finally(() => {
      clearTimeout(releaseTimeout);
      supabase.auth.signOut({ scope: 'local' }).catch(console.error);
    });
    terminatingRef.current = false;
    setIsTerminating(false);
    warningsRef.current = 0;
    isAlertingRef.current = false;
    submissionStartedRef.current = false;
    resetExamClock();
    setCurrentStudent(null);
    setExamState('AUTH');
  }, [isAlertingRef, setCurrentStudent, setExamState, warningsRef]);
  safeLogoutRef.current = handleSafeLogout;

  const handleStudentLogin = useCallback((/** @type {CurrentStudent} */ student) => {
    studentSessionLockedRef.current = false;
    setStudentSessionLocked(false);
    setCurrentStudent(student);
    setExamState('STUDENT_DASHBOARD');
  }, [setCurrentStudent, setExamState]);

  // A stored dashboard route is not proof of authentication. Ensure the
  // candidate stored in the browser is the currently authenticated user.
  useEffect(() => {
    if (examState !== 'STUDENT_DASHBOARD') return;
    let active = true;
    supabase.auth.getUser().then(({ data: { user }, error }) => {
      if (!active) return;
      if (error || !user || !currentStudent?.docId || user.id !== currentStudent.docId) {
        handleSafeLogout();
      }
    });
    return () => { active = false; };
  }, [examState, currentStudent?.docId, handleSafeLogout]);

  // An offline recovery record is not proof of identity. Validate the locally
  // cached Supabase session before displaying a cached exam paper.
  useEffect(() => {
    if (!['PRE_EXAM', 'ACTIVE'].includes(examState)) return;
    let active = true;
    const authListener = supabase.auth.onAuthStateChange?.((_event, session) => {
      authAccessTokenRef.current = session?.access_token || null;
    });
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (!active) return;
      authAccessTokenRef.current = session?.access_token || null;
      if (error || !session?.user || !currentStudent?.docId || session.user.id !== currentStudent.docId) {
        handleSafeLogout({ preserveAttempt: true });
      }
    });
    return () => {
      active = false;
      authListener?.data.subscription.unsubscribe();
    };
  }, [examState, currentStudent?.docId, handleSafeLogout]);

  const handleSessionReplaced = useCallback(() => {
    if (studentSessionLockedRef.current) return;
    studentSessionLockedRef.current = true;
    setStudentSessionLocked(true);
    setAutosaveStatus('LOCKED');
    handleSafeLogout({ preserveAttempt: true });
    void customAlert('This login was replaced by another device. Local pending answers were preserved on this device; only answers confirmed by the server can be graded after the deadline.');
  }, [handleSafeLogout]);

  const applyRuntimeClock = useCallback((/** @type {import('../../types').UntrustedInput} */ runtime) => {
    if (runtime?.server_now) anchorExamClock(runtime.server_now);
    if (runtime?.deadline_at) {
      const deadline = Date.parse(runtime.deadline_at);
      if (Number.isFinite(deadline)) {
        sessionEndTimeRef.current = deadline;
        setSessionEndTime(deadline);
      }
    }
  }, []);

  const { postpone: postponeRuntimePoll } = useStudentPolling({
    enabled: Boolean(currentStudent && activeExam && ['PRE_EXAM', 'ACTIVE'].includes(examState)),
    key: `${currentStudent?.docId}:${activeExam?.id}:${examState}`,
    poll: async (signal) => {
      try {
        const { data, error } = await supabase.rpc('student_exam_runtime', { exam_id_param: activeExam?.id }).abortSignal(signal);
        if (signal.aborted) return;
        if (error) throw error;
        if (!data) throw new Error('Invalid exam runtime response.');
        setRuntimeStatus(data.exam_status);
        setRuntimeError('');
        applyRuntimeClock(data);
        if (data.session_owned === false) {
          handleSessionReplaced();
        } else if (data.status === 'SUBMITTED' && data.result) {
          savePipelineRef.current?.dispose();
          savePipelineRef.current = null;
          clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam?.id, userUuid: currentStudent?.docId });
          setResults(committedResultToScorecard(data.result));
          setExamState('SUBMITTED');
        } else if (data.status === 'TERMINATED') {
          savePipelineRef.current?.dispose();
          savePipelineRef.current = null;
          setTerminationReason(data.termination_reason || 'ended');
          setExamState('TERMINATED');
        } else if (examState === 'ACTIVE' && data.access_generation !== undefined
          && data.access_generation !== null && data.access_generation !== accessGenerationRef.current) {
          savePipelineRef.current?.dispose();
          savePipelineRef.current = null;
          // Keep the old local generation until start reconciles it with the server.
          setRecoveryNotice('Access was re-granted. Resume to load the server-confirmed answers; this device’s pending copy cannot overwrite them.');
          setExamState('PRE_EXAM');
        }
      } catch (error) {
        if (signal.aborted) return;
        if (isStudentSessionReplaced(error)) handleSessionReplaced();
        else setRuntimeError('Unable to verify the exam status. Check your connection.');
        throw error;
      }
    }
  });

  const saveScope = `${currentStudent?.docId}:${activeExam?.id}:${accessGeneration}`;
  const saveScopeRef = useRef(saveScope);
  useEffect(() => { saveScopeRef.current = saveScope; }, [saveScope]);

  const saveAnswers = useCallback(async (/** @type {ExamResponses} */ payload) => {
    if (!currentStudent || !activeExam) throw new Error('An active student and exam are required to save.');
    const savedGeneration = accessGenerationRef.current;
    const scope = `${currentStudent.docId}:${activeExam.id}:${savedGeneration}`;
    const assertWritable = () => {
      if (!savePipelineRef.current || studentSessionLockedRef.current || terminatingRef.current || scope !== saveScopeRef.current || savedGeneration !== accessGenerationRef.current) {
        throw new Error('The answer save pipeline is closed.');
      }
    };
    assertWritable();
    if (lastConfirmedResponsesRef.current && sameResponses(payload, lastConfirmedResponsesRef.current)) return sessionVersionRef.current;
    // Freeze all retry parameters. A lost response must not turn a retry into a
    // different write against the same version.
    const timing = getSubjectTimeSnapshot();
    const args = {
      exam_id_param: activeExam.id,
      responses_param: payload,
      expected_version_param: sessionVersionRef.current,
      access_generation_param: accessGenerationRef.current,
      ...(timingInFlightRef.current ? {} : { subject_time_seconds_param: timing })
    };
    isSavingRef.current = true;
    try {
      for (let retry = 0; retry <= 3; retry += 1) {
        assertWritable();
        if (retry > 0) {
          setAutosaveStatus('RETRYING');
          await new Promise(resolve => setTimeout(resolve, retryDelayMs(retry, { capMs: 5000 })));
          assertWritable();
        }
        if (sessionEndTimeRef.current && getExamActionNow() >= sessionEndTimeRef.current) {
          setAutosaveStatus('LOCKED');
          setRecoveryNotice('The deadline has passed. Only server-confirmed answers will be graded; locally pending answers cannot be recovered after expiry.');
          return null;
        }
        try {
          const { data, error, status } = await supabase.rpc('sync_active_session_progress', args);
          assertWritable();
          if (error) throw Object.assign(error, { httpStatus: status });
          applyRuntimeClock(data);
          const ownLostSave = data?.conflict && data.user_responses && sameResponses(data.user_responses, payload);
          if (data?.success || ownLostSave) {
            sessionVersionRef.current = data.version;
            lastConfirmedResponsesRef.current = payload;
            if (data.timing_saved) markSubjectTimeSaved(timing);
            postponeRuntimePoll();
            if (sameResponses(payload, responsesRef.current)) {
              const local = saveOfflineRecoveryRecord({
                student: currentStudent, examId: activeExam.id, examTitle: activeExam.title,
                userUuid: currentStudent.docId, examData, userResponses: payload,
                activeSubject, currentIndices, version: data.version,
                endTime: /** @type {number | undefined} */ (sessionEndTimeRef.current), accessGeneration: accessGenerationRef.current
              });
              setLocalRecoveryAvailable(local.success);
              setAutosaveStatus('SAVED');
            }
            return data.version;
          }
          if (data?.conflict) {
            sessionVersionRef.current = data.version;
            if (data.user_responses) {
              lastConfirmedResponsesRef.current = data.user_responses;
              setUserResponses(data.user_responses);
            }
            setAutosaveStatus('CONFLICT');
            setRecoveryNotice('A newer server-confirmed answer set was found, so this stale tab was not allowed to overwrite it. Review your answers before continuing.');
            throw Object.assign(new Error('A newer server-confirmed answer set was found. Review the restored answers and submit again.'), { code: APP_ERROR.CONFLICT });
          }
          throw new Error('The exam server returned an invalid autosave response.');
        } catch (error) {
          if (classifyAppError(error) === APP_ERROR.TIME_EXPIRED) {
            setAutosaveStatus('LOCKED');
            setRecoveryNotice('The deadline has passed. Only server-confirmed answers will be graded; locally pending answers cannot be recovered after expiry.');
            return null;
          }
          if (!isTransientRpcError(/** @type {import('../../types').RpcErrorLike} */ (error), { online: navigator.onLine }) || retry === 3) throw error;
        }
      }
      return null;
    } finally {
      isSavingRef.current = false;
    }
  }, [currentStudent, activeExam, getSubjectTimeSnapshot, applyRuntimeClock, markSubjectTimeSaved, postponeRuntimePoll, examData, activeSubject, currentIndices, timingInFlightRef]);
  const saveAnswersRef = useRef(saveAnswers);
  useEffect(() => { saveAnswersRef.current = saveAnswers; }, [saveAnswers]);
  const savePipelineRef = useRef(/** @type {ReturnType<typeof createExamSavePipeline<ExamResponses>> | null} */ (null));
  useEffect(() => {
    const pipeline = createExamSavePipeline((/** @type {ExamResponses} */ payload) => {
      if (saveScope !== saveScopeRef.current) return Promise.reject(new Error('The answer save pipeline is closed.'));
      return saveAnswersRef.current(payload);
    });
    savePipelineRef.current = pipeline;
    return () => { pipeline.dispose(); savePipelineRef.current = null; };
  }, [saveScope]);

  useEffect(() => {
    if (examState !== 'ACTIVE' || !currentStudent || !activeExam || studentSessionLockedRef.current || terminatingRef.current || submissionStartedRef.current) return;
    const localSave = saveOfflineRecoveryRecord({
      student: currentStudent, examId: activeExam.id, examTitle: activeExam.title,
      userUuid: currentStudent.docId, examData, userResponses, activeSubject, currentIndices,
      version: sessionVersionRef.current, endTime: /** @type {number | undefined} */ (sessionEndTimeRef.current),
      accessGeneration: accessGenerationRef.current
    });
    setLocalRecoveryAvailable(localSave.success);
    const remaining = (sessionEndTimeRef.current || Infinity) - getExamActionNow();
    if (remaining <= 0) { setAutosaveStatus('LOCKED'); return; }
    if (!navigator.onLine || offlineSince) { setAutosaveStatus(localSave.success ? 'OFFLINE' : 'FAILED'); return; }
    if (lastConfirmedResponsesRef.current && sameResponses(userResponses, lastConfirmedResponsesRef.current)) return;
    setAutosaveStatus('SAVING');
    const timer = setTimeout(() => {
      if (submissionStartedRef.current || terminatingRef.current) return;
      void savePipelineRef.current?.save(userResponses).catch(error => {
        if (studentSessionLockedRef.current || terminatingRef.current || saveScope !== saveScopeRef.current) return;
        if (isStudentSessionReplaced(error)) { handleSessionReplaced(); return; }
        if (classifyAppError(error) === APP_ERROR.CONFLICT) {
          if (error.code === 'EX015') setExamState('PRE_EXAM');
          return;
        }
        setAutosaveStatus(isTransientRpcError(error, { online: navigator.onLine }) && localSave.success ? 'OFFLINE' : 'FAILED');
        if (!localSave.success) setRecoveryNotice('This browser could not store a recovery copy. Keep this page open and restore the connection immediately.');
      });
    }, remaining <= 10_000 ? 250 : 1000);
    return () => clearTimeout(timer);
  }, [userResponses, examState, currentStudent, activeExam, examData, activeSubject, currentIndices, offlineSince, handleSessionReplaced, saveScope, setExamState]);

  const terminateExam = useCallback(async (/** @type {TerminationReason} */ reason = 'ended') => {
    if (studentSessionLockedRef.current || terminatingRef.current) return;
    terminatingRef.current = true;
    savePipelineRef.current?.dispose();
    savePipelineRef.current = null;
    lockdownActiveRef.current = true;
    // No further warnings while the attempt is being ended.
    isAlertingRef.current = true;
    setTerminationReason(reason);
    setIsTerminating(true);

    if (currentStudent && activeExam) {
      // 1. Block locally and persist pending termination before awaiting the network
      savePendingTerminationRecord({
        student: currentStudent,
        examId: activeExam.id,
        userUuid: currentStudent.docId,
        reason,
        accessGeneration: accessGenerationRef.current
      });
      // The attempt is over on this device either way: never offer to resume it.
      clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam.id, userUuid: currentStudent.docId });

      try {
        const args = {
          exam_id_param: activeExam.id,
          reason_param: reason,
          access_generation_param: accessGenerationRef.current
        };
        // Dispatch before any await: keepalive survives pagehide/tab closure.
        const request = authAccessTokenRef.current && supabaseUrl && supabaseAnonKey
          ? fetch(`${supabaseUrl}/rest/v1/rpc/terminate_exam`, {
              method: 'POST',
              keepalive: true,
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseAnonKey,
                'Authorization': `Bearer ${authAccessTokenRef.current}`
              },
              body: JSON.stringify(args)
            }).then(async response => {
              const data = await response.json();
              return { error: response.ok ? null : data };
            })
          : supabase.rpc('terminate_exam', args);
        const { error } = await withTimeout(request, TERMINATE_REQUEST_TIMEOUT_MS);
        if (error) throw error;
        clearPendingTerminationRecord({ student: currentStudent, userUuid: currentStudent.docId });
      } catch (err) {
        console.error("Failed to persist termination result:", err);
        if (isStudentSessionReplaced(err)) {
          terminatingRef.current = false;
          setIsTerminating(false);
          studentSessionLockedRef.current = true;
          setStudentSessionLocked(true);
          handleSafeLogout({ preserveAttempt: true });
          setTimeout(() => customAlert(examActionErrorMessage(err, 'submit')), 100);
          return;
        }
      }
    }

    setIsTerminating(false);
    setExamState('TERMINATED');
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error(err));
    }
    navigator.keyboard?.unlock?.();
  }, [currentStudent, activeExam, handleSafeLogout, setExamState, isAlertingRef, lockdownActiveRef]);

  useEffect(() => {
    terminateExamRef.current = terminateExam;
  }, [terminateExam]);

  // Auto-submit once when the fixed deadline passes. The deadline is derived
  // from the fixed end time, so sleep, background throttling, and a busy main
  // thread cannot give the candidate extra time.
  useEffect(() => {
    if (examState !== 'ACTIVE' || !isExamLocked) return;
    confirmSubmitExamRef.current?.();
  }, [examState, isExamLocked]);

  /** @param {ActiveExam} exam */
  const handleStartExamFlow = async (exam) => {
    terminatingRef.current = false;
    setIsTerminating(false);
    warningsRef.current = 0;
    isAlertingRef.current = false;
    clearLockdown();
    subjectTimeRef.current = {};
    submissionStartedRef.current = false;
    lastConfirmedResponsesRef.current = null;
    sessionVersionRef.current = 1;
    sessionEndTimeRef.current = null;
    setSessionEndTime(null);
    setRuntimeStatus('PENDING');
    setRuntimeError('');
    setActiveExam(exam);
    const data = exam.questionsData || exam.questions_data || { subjects: [], questions: {} };

    let restoredResponses = null;
    let restoredExamData = null;
    let serverVersion = null;
    if (currentStudent) {
      try {
        const { data: sessionData, error } = await supabase
          .from('active_sessions')
          .select('*')
          .eq('id', `${currentStudent.docId}_${exam.id}`)
          .single();

        if (!error && sessionData) {
          if (sessionData.status === 'TERMINATED') {
            setTerminationReason(sessionData.termination_reason || 'SECURITY_VIOLATION');
            setExamState('TERMINATED');
            if (sessionData.deadline_at) {
              const calculatedEndTime = new Date(sessionData.deadline_at).getTime();
              sessionEndTimeRef.current = calculatedEndTime;
              setSessionEndTime(calculatedEndTime);
            }
            return;
          }
          accessGenerationRef.current = sessionData.access_generation ?? null;
          setAccessGeneration(accessGenerationRef.current);
          restoredResponses = sessionData.user_responses || null;
          restoredExamData = sessionData.jumbled_exam_data || null;
          subjectTimeRef.current = sessionData.subject_time_seconds || {};
          serverVersion = Number(sessionData.version || 1);
          sessionVersionRef.current = serverVersion;
        }
      } catch (err) {
        console.error("Failed to restore session from server", err);
      }
      /** @type {(Partial<import('../../types').OfflineRecoveryRecord> & Partial<import('../../types').ActiveExamSessionMirror>) | null} */
      const local = readOfflineRecoveryRecord({
        student: currentStudent,
        examId: exam.id,
        userUuid: currentStudent.docId
      }) || readStoredSessionMirror();

      if (local && (local.examId === exam.id || local.activeExam?.id === exam.id) && sessionBelongsToStudent(local, currentStudent)) {
        if (!restoredResponses) {
          restoredResponses = local.userResponses;
          restoredExamData = restoredExamData || local.examData;
          sessionVersionRef.current = Number(local.version || 1);
        } else {
          const reconciliation = reconcileOfflineRecovery({
            examData: restoredExamData || data,
            serverResponses: restoredResponses,
            serverVersion,
            serverAccessGeneration: accessGenerationRef.current,
            localRecord: local
          });
          restoredResponses = reconciliation.responses;
          if (reconciliation.conflict) {
            setRecoveryNotice('A newer server-confirmed session was found. The older local copy was not allowed to overwrite it.');
          }
        }
      }
    }

    let finalExamData;
    if (restoredExamData && restoredResponses) {
      finalExamData = restoredExamData;
    } else {
      // Jumble / shuffle questions for each subject so every student gets a randomized order
      /** @type {NonNullable<ExamPaper['questions']>} */
      const jumbledQuestions = {};
      (data.subjects || []).forEach(sub => {
        const subQuestions = data.questions?.[sub] || [];
        jumbledQuestions[sub] = shuffleQuestionBlocks(subQuestions);
      });
      finalExamData = {
        ...data,
        questions: jumbledQuestions
      };
    }

    setExamData(finalExamData);
    const firstSub = finalExamData.subjects?.[0] || Object.keys(finalExamData.questions || {})[0] || '';
    setActiveSubject(firstSub);

    /** @type {CurrentIndices} */
    const indices = {};
    (finalExamData.subjects || []).forEach((/** @type {string} */ sub) => { indices[sub] = 0; });
    setCurrentIndices(indices);

    // No countdown is shown before the server session exists: startExam derives
    // the authoritative deadline from the server's remaining time.
    if (restoredResponses && restoredExamData) {
      setUserResponses(restoredResponses);
    } else {
      const initialState = createInitialResponses(finalExamData);
      setUserResponses(initialState);
    }

    setExamState('PRE_EXAM');
  };

  const startExam = async () => {
    if (studentSessionLockedRef.current || terminatingRef.current) return;
    if (!currentStudent || !activeExam) {
      await customAlert('Your exam session could not be started. Please sign in again and retry.');
      return;
    }

    // Full-screen is a browser-level deterrent, not an authorization check.
    // Do not let a browser refusing it bypass creation of the server session.
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ keyboardLock: 'browser' });
      }
      if (document.fullscreenElement && navigator.keyboard?.lock) {
        await navigator.keyboard.lock();
      }
    } catch (err) {
      console.warn('Fullscreen could not be enabled:', err);
    }

    try {
      // The server always uses its own stored paper and initial responses, so the
      // legacy parameters are sent empty. This avoids every candidate uploading
      // the full paper at the same moment when a sitting starts.
      const { data: session, error } = await supabase.rpc('start_exam_session', {
        exam_id_param: activeExam.id,
        exam_data_param: null,
        responses_param: null
      });
      if (error) throw error;
      applyRuntimeClock(session);
      if (session?.expired) {
        await customAlert('Your exam time has expired. Your attempt has been finalized.');
        const { data: committedResult } = await supabase
          .from('student_results')
          .select('*')
          .eq('student_id', currentStudent.id)
          .eq('exam_id', activeExam.id)
          .single();
        if (committedResult) {
          clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam.id, userUuid: currentStudent.docId });
          setResults(committedResultToScorecard(committedResult));
          setExamState('SUBMITTED');
        } else {
          setExamState('TERMINATED');
        }
        return;
      }
      if (session?.status === 'TERMINATED') {
        setTerminationReason(session.reason || 'SECURITY_VIOLATION');
        setExamState('TERMINATED');
        if (session.deadline_at) {
          const calculatedEndTime = new Date(session.deadline_at).getTime();
          sessionEndTimeRef.current = calculatedEndTime;
          setSessionEndTime(calculatedEndTime);
        }
        return;
      }

      subjectTimeRef.current = session?.subject_time_seconds || {};
      markSubjectTimeSaved(subjectTimeRef.current);
      const localGeneration = accessGenerationRef.current;
      const gen = session?.access_generation ?? null;
      accessGenerationRef.current = gen;
      setAccessGeneration(gen);

      const localBaseVersion = Number(sessionVersionRef.current || 1);
      const authoritativeVersion = Number(session?.version || 1);
      sessionVersionRef.current = authoritativeVersion;
      const activeData = session?.jumbled_exam_data || examData;
      if (session?.jumbled_exam_data) setExamData(session.jumbled_exam_data);
      if (session?.user_responses) {
        lastConfirmedResponsesRef.current = session.user_responses;
        const reconciliation = reconcileOfflineRecovery({
          examData: activeData,
          serverResponses: session.user_responses,
          serverVersion: authoritativeVersion,
          serverAccessGeneration: gen,
          localRecord: { version: localBaseVersion, accessGeneration: localGeneration, userResponses }
        });
        setUserResponses(/** @type {ExamResponses} */ (reconciliation.responses));
        if (reconciliation.conflict) {
          setRecoveryNotice('The server had newer confirmed progress or re-granted access. This device’s stale copy was not applied. Review your answers before continuing.');
        }
      }
      const remainingSeconds = session?.time_left !== undefined && session?.time_left !== null
        ? session.time_left
        : (examData.duration || 180) * 60;
      const calculatedEndTime = session?.deadline_at ? Date.parse(session.deadline_at) : getExamActionNow() + (remainingSeconds * 1000);
      sessionEndTimeRef.current = calculatedEndTime;
      setSessionEndTime(calculatedEndTime);

      // Diagrams remain private and load on demand; avoid a whole-paper burst.

      // Start Exam after a server-owned session has been created or restored.
      setExamState('ACTIVE');
      subjectTickRef.current = performance.now();
      announceAssertive(`Examination started. Time remaining: ${Math.round(remainingSeconds / 60)} minutes.`);
    } catch (err) {
      console.error('Unable to create exam session:', err);
      await customAlert(examActionErrorMessage(err, 'start'));
      if (isStudentSessionReplaced(err)) {
        studentSessionLockedRef.current = true;
        setStudentSessionLocked(true);
        handleSafeLogout({ preserveAttempt: true });
      }
    }
  };

  const submitExam = useCallback(() => {
    if (studentSessionLockedRef.current || terminatingRef.current) return;
    setShowSubmitModal(true);
  }, []);

  const calculateResults = async () => {
    if (studentSessionLockedRef.current) {
      throw new Error('This student session has been replaced or is no longer active');
    }
    if (!currentStudent || !activeExam) {
      throw new Error('An active student and exam are required to submit.');
    }

    // Drain the same queue as autosave. The deadline check also runs after each
    // retry wait, and an expired submit grades only the server's stored answers.
    confirmedSubmissionVersionRef.current = null;
    let mayAlreadyBeCommitted = false;
    let confirmedVersion = null;
    try {
      if (!savePipelineRef.current) throw new Error('The answer save pipeline is closed.');
      confirmedVersion = await savePipelineRef.current.save(responsesRef.current);
    } catch (error) {
      mayAlreadyBeCommitted = /** @type {string[]} */ ([APP_ERROR.SESSION_NOT_FOUND, APP_ERROR.ALREADY_SUBMITTED]).includes(classifyAppError(error));
      if (!mayAlreadyBeCommitted) throw error;
    }
    if (!mayAlreadyBeCommitted) {
      try { await syncSubjectTime({ onlyIfChanged: true }); }
      catch (error) { console.warn('Final subject timing was not saved; grading confirmed answers:', error); }
    }

    confirmedSubmissionVersionRef.current = confirmedVersion;
    // The final save confirmed this version; grading uses only the server copy.
    const submitArgs = {
      exam_id_param: activeExam.id,
      responses_param: null,
      ...(confirmedVersion !== null ? { expected_version_param: confirmedVersion } : {}),
      access_generation_param: accessGenerationRef.current
    };
    let finalResults;
    for (let attempt = 1; ; attempt += 1) {
      const { data, error, status } = await supabase.rpc('submit_exam', submitArgs);
      if (!error) {
        finalResults = data;
        break;
      }
      const submitError = Object.assign(error, { httpStatus: status });
      if (attempt >= 4 || !isTransientRpcError(submitError, { online: navigator.onLine })) {
        console.error('Failed to save result to Supabase:', submitError);
        throw submitError;
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs(attempt)));
    }

    setResults(finalResults);
  };

  const confirmSubmitExam = async () => {
    if (submissionStartedRef.current || studentSessionLockedRef.current || terminatingRef.current) return;
    submissionStartedRef.current = true;
    setShowSubmitModal(false);
    setIsSubmitting(true);
    setSubmissionError(null);
    announceAssertive('Submitting examination. Please wait...');
    try {
      await calculateResults();
      clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam?.id, userUuid: currentStudent?.docId });
      setExamState('SUBMITTED');
      announceAssertive('Examination submitted successfully.');
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.error(err));
      }
    } catch (err) {
      if (classifyAppError(err) === APP_ERROR.ALREADY_SUBMITTED) {
        const { data: committedResult } = await supabase
          .from('student_results')
          .select('*')
          // ALREADY_SUBMITTED only comes from calculateResults, which requires a student.
          .eq('student_id', /** @type {CurrentStudent} */ (currentStudent).id)
          .eq('exam_id', activeExam?.id)
          .single();
        if (committedResult) {
          clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam?.id, userUuid: currentStudent?.docId });
          setResults(committedResultToScorecard(committedResult));
          setExamState('SUBMITTED');
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(err => console.error(err));
          }
          return;
        }
      }

      submissionStartedRef.current = false;
      console.error("Failed to submit exam:", err);
      if (isStudentSessionReplaced(err)) {
        studentSessionLockedRef.current = true;
        setStudentSessionLocked(true);
        const friendlyMsg = examActionErrorMessage(err, 'submit');
        setSubmissionError(friendlyMsg);
        handleSafeLogout({ preserveAttempt: true });
        await customAlert(friendlyMsg);
        return;
      }
      if (/** @type {import('../../types').RpcErrorLike} */ (err)?.code === 'EX013' || /** @type {import('../../types').RpcErrorLike} */ (err)?.code === 'EX015') {
        lastConfirmedResponsesRef.current = null;
        setExamState('PRE_EXAM');
      }
      if (currentStudent && activeExam && isTransientRpcError(/** @type {import('../../types').RpcErrorLike} */ (err), { online: navigator.onLine })
        && (confirmedSubmissionVersionRef.current !== null || (sessionEndTimeRef.current && getExamActionNow() >= sessionEndTimeRef.current))) {
        const pendingSave = savePendingSubmissionRecord({
          student: currentStudent,
          examId: activeExam.id,
          userUuid: currentStudent.docId,
          responses: [],
          expectedVersion: confirmedSubmissionVersionRef.current,
          accessGeneration: accessGenerationRef.current
        });
        if (!pendingSave.success) {
          console.error('Failed to cache offline submission:', pendingSave.error);
          setRecoveryNotice('This browser could not save the queued submission. Keep this page open and restore the connection immediately.');
        }
      }
      const friendlyMsg = examActionErrorMessage(err, 'submit');
      setSubmissionError(friendlyMsg);
      await customAlert(friendlyMsg);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    confirmSubmitExamRef.current = confirmSubmitExam;
  });

  const {
    selectResponse,
    handleAction,
    goNext,
    goPrev,
    changeQuestion,
    handleSubjectChange
  } = useExamNavigation({
    examData,
    activeSubject,
    setActiveSubject,
    currentIndices,
    setCurrentIndices,
    userResponses,
    setUserResponses,
    offlineSince,
    setAutosaveStatus,
    studentSessionLockedRef,
    terminatingRef,
    submissionStartedRef,
    sessionEndTimeRef
  });

  const currentQIndex = currentIndices[activeSubject] || 0;
  const currentQuestion = examData?.questions?.[activeSubject] ? examData.questions[activeSubject][currentQIndex] : null;
  const currentResponse = userResponses?.[activeSubject] ? userResponses[activeSubject][currentQIndex] : NOT_VISITED_RESPONSE;
  const totalSubQuestions = examData?.questions?.[activeSubject] ? examData.questions[activeSubject].length : 0;

  const subjectIndex = examData?.subjects ? examData.subjects.indexOf(activeSubject) : -1;
  const isFirstQuestionOfExam = subjectIndex === 0 && currentQIndex === 0;
  const isLastQuestionOfExam = examData?.subjects && subjectIndex === examData.subjects.length - 1 && currentQIndex === totalSubQuestions - 1;

  const setSelectedOption = useCallback((/** @type {import('../../types').SelectedOption} */ val) => selectResponse(currentQIndex, val), [selectResponse, currentQIndex]);
  const activeSubjectResponses = userResponses[activeSubject];
  const questionStatuses = useMemo(
    () => (activeSubjectResponses ? activeSubjectResponses.map(r => r.status) : []),
    [activeSubjectResponses]
  );

  return {
    // Session data
    runtimeStatus,
    runtimeError,
    handleSessionReplaced,
    activeExam,
    examData,
    activeSubject,
    userResponses,
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
    accessGeneration,
    // Lockdown
    lockdownActive,
    warning,
    isTerminating,
    terminationReason,
    handleReturnToExam,
    // Submission
    showSubmitModal,
    setShowSubmitModal,
    submitButtonRef,
    submissionError,
    isSubmitting,
    submitExam,
    confirmSubmitExam,
    terminateExam,
    // Lifecycle
    handleStudentLogin,
    handleSafeLogout,
    handleStartExamFlow,
    startExam,
    // Current question view
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
  };
}
