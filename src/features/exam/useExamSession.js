/// <reference path="./browserApis.d.ts" />
// Student exam session: start/resume, versioned autosave with offline
// recovery, takeover detection, lockdown violations, subject timing, and the
// submit/terminate flows. App.jsx owns only routing state and passes it in.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { APP_ERROR, classifyAppError } from '../../appErrors';
import { supabase } from '../../supabase';
import { customAlert } from '../../utils';
import { safeStorageGet, safeStorageSet, safeStorageRemove } from '../../browserStorage';
import {
  buildSubmissionResponses,
  createInitialResponses,
  sessionBelongsToStudent,
  saveOfflineRecoveryRecord,
  readOfflineRecoveryRecord,
  clearOfflineRecoveryRecord,
  mergeOfflineResponses,
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
import { preloadExamImages } from '../../components/StorageImage';
import { announceAssertive } from '../../components/LiveAnnouncer';
import {
  emptyExam,
  readStoredSessionMirror,
  isStudentSessionReplaced,
  examActionErrorMessage,
  committedResultToScorecard,
  shuffleArray
} from './examSessionHelpers';
import { useDeadlineReached } from './examClock';
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
 * @typedef {'SAVED' | 'SAVING' | 'RETRYING' | 'OFFLINE' | 'FAILED' | 'LOCKED' | 'CONFLICT'} AutosaveStatus
 * @typedef {import('../../types').ActiveExamSessionMirror & {
 *   subjectTimeSeconds?: Record<string, number>
 * }} InitialActiveSession Stored session mirror restored on reload.
 */

/** @type {QuestionResponse} */
const NOT_VISITED_RESPONSE = { selectedOption: null, status: 'NOT_VISITED' };

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
  const [autosaveStatus, setAutosaveStatus] = useState(/** @type {AutosaveStatus} */ ('SAVED'));
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [localRecoveryAvailable, setLocalRecoveryAvailable] = useState(true);
  const sessionVersionRef = useRef(initialActiveSession?.version || 1);
  const isSavingRef = useRef(false);
  const pendingSaveRef = useRef(/** @type {{ payload: ExamResponses, generation: number } | null} */ (null));
  // Last answer set the server confirmed. Navigation-only changes are persisted
  // locally but never re-sent, which removes most redundant autosave writes.
  const lastConfirmedResponsesRef = useRef(/** @type {ExamResponses | null} */ (null));
  const autosaveGenerationRef = useRef(0);
  const safeLogoutRef = useRef(/** @type {((options?: SafeLogoutOptions) => void) | null} */ (null));
  const studentSessionLockedRef = useRef(false);
  const [studentSessionLocked, setStudentSessionLocked] = useState(false);
  const terminateExamRef = useRef(/** @type {(() => Promise<void>) | undefined} */ (undefined));
  const confirmSubmitExamRef = useRef(/** @type {(() => Promise<void>) | undefined} */ (undefined));

  const {
    warningsRef,
    isAlertingRef,
    lockdownActiveRef,
    lockdownActive,
    clearLockdown,
    handleReturnToExam
  } = useExamLockdown({ active: examState === 'ACTIVE', terminateExamRef });

  // Only the transition to "deadline reached" re-renders the session; the
  // per-second countdown text is rendered by ExamNavbar's own clock subscriber.
  const isExamLocked = useDeadlineReached(sessionEndTime, examState === 'ACTIVE');

  const flushPendingTermination = useCallback(async () => {
    if (!currentStudent) return;
    const pending = readPendingTerminationRecord({ student: currentStudent, userUuid: currentStudent.docId });
    if (!pending) return;
    try {
      const { error } = await supabase.rpc('terminate_exam', { exam_id_param: pending.examId });
      if (error) throw error;
      clearOfflineRecoveryRecord({ student: currentStudent, examId: pending.examId, userUuid: currentStudent.docId });
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
    if (!currentStudent) return;
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
      setSubmissionError('Submitting previously saved offline responses...');
      const { data: finalResults, error } = await supabase.rpc('submit_exam', {
        exam_id_param: examId,
        responses_param: parsed.responses
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
    warningsRef.current = 0;
    isAlertingRef.current = false;
    submissionStartedRef.current = false;
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
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      if (!active) return;
      if (error || !session?.user || !currentStudent?.docId || session.user.id !== currentStudent.docId) {
        handleSafeLogout({ preserveAttempt: true });
      }
    });
    return () => { active = false; };
  }, [examState, currentStudent?.docId, handleSafeLogout]);

  // Session hijacking listener (Supabase Realtime)
  useEffect(() => {
    if (!currentStudent || !currentStudent.docId || examState === 'AUTH') return;

    // Check if docId is a valid UUID to prevent query exceptions for mock students
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentStudent.docId);
    if (!isUuid) return;

    let disposed = false;
    /** @param {unknown} activeAuthSessionId */
    const lockIfReplaced = (activeAuthSessionId) => {
      if (disposed || studentSessionLockedRef.current || activeAuthSessionId === undefined) return;
      const currentLocalToken = safeStorageGet('localStorage', 'examSessionToken') || currentStudent.sessionToken;
      if (activeAuthSessionId !== currentLocalToken) {
        isAlertingRef.current = true;
        studentSessionLockedRef.current = true;
        setStudentSessionLocked(true);
        handleSafeLogout({ preserveAttempt: true });
        setTimeout(() => {
          customAlert('This login was replaced by another device. The local recovery copy on this device was preserved, but it can no longer autosave, submit, or terminate this attempt.')
            .then(() => {
              isAlertingRef.current = false;
            });
        }, 100);
      }
    };

    const channel = supabase
      .channel(`student-session-${currentStudent.docId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'students',
        filter: `id=eq.${currentStudent.docId}`
      }, (payload) => lockIfReplaced(payload.new?.active_auth_session_id))
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        // A takeover that happened while the channel was connecting produces no
        // event, so confirm the current owner once the subscription is live.
        const { data } = await supabase
          .from('students')
          .select('active_auth_session_id')
          .eq('id', currentStudent.docId)
          .maybeSingle();
        if (data) lockIfReplaced(data.active_auth_session_id);
      });

    return () => {
      disposed = true;
      supabase.removeChannel(channel);
    };
  }, [currentStudent, examState, handleSafeLogout, isAlertingRef]);

  // Bounded, deterministic autosave engine with optimistic concurrency and offline recovery
  useEffect(() => {
    if (examState !== 'ACTIVE' || !currentStudent || !activeExam || !userResponses || !examData) return;
    if (studentSessionLockedRef.current) return;
    const saveGeneration = ++autosaveGenerationRef.current;

    // Immediate zero-data-loss local persistence
    const localSave = saveOfflineRecoveryRecord({
      student: currentStudent,
      examId: activeExam.id,
      examTitle: activeExam.title,
      userUuid: currentStudent.docId,
      examData,
      userResponses,
      activeSubject,
      currentIndices,
      version: sessionVersionRef.current,
      endTime: /** @type {number | undefined} */ (sessionEndTimeRef.current)
    });
    setLocalRecoveryAvailable(localSave.success);

    if (sessionEndTimeRef.current && Date.now() >= sessionEndTimeRef.current) {
      setAutosaveStatus('LOCKED');
      return;
    }

    if (!navigator.onLine || offlineSince) {
      setAutosaveStatus(localSave.success ? 'OFFLINE' : 'FAILED');
      return;
    }

    if (lastConfirmedResponsesRef.current && sameResponses(userResponses, lastConfirmedResponsesRef.current)) {
      // Only the position changed; the answers are already server-confirmed.
      setAutosaveStatus(prev => (prev === 'SAVING' || prev === 'RETRYING' ? 'SAVED' : prev));
      return;
    }

    // A changed response is not server-confirmed until the debounced RPC succeeds.
    // Mark it pending immediately so the UI never presents stale "saved" state.
    setAutosaveStatus('SAVING');

    const timer = setTimeout(async () => {
      if (isSavingRef.current) {
        pendingSaveRef.current = { payload: userResponses, generation: saveGeneration };
        return;
      }

      /**
       * @param {ExamResponses} payload
       * @param {number} generation
       */
      const executeSave = async (payload, generation) => {
        if (studentSessionLockedRef.current) return;
        isSavingRef.current = true;
        try {
          for (let retry = 0; retry <= 3; retry += 1) {
            if (studentSessionLockedRef.current) return;
            if (sessionEndTimeRef.current && Date.now() >= sessionEndTimeRef.current) {
              setAutosaveStatus('LOCKED');
              return;
            }
            if (retry > 0) {
              if (generation === autosaveGenerationRef.current) setAutosaveStatus('RETRYING');
              await new Promise(resolve => setTimeout(resolve, retryDelayMs(retry, { capMs: 5000 })));
            }

            try {
              const { data: syncData, error: syncError, status: syncStatus } = await supabase.rpc('sync_active_session_progress', {
                exam_id_param: activeExam.id,
                responses_param: payload,
                expected_version_param: sessionVersionRef.current
              });
              if (syncError) throw Object.assign(syncError, { httpStatus: syncStatus });

              // A retry after a lost response reports a version conflict even though
              // the server already holds exactly this answer set. Treat it as saved.
              const ownLostSave = syncData?.conflict && syncData.user_responses
                && sameResponses(syncData.user_responses, payload);

              if (syncData?.success || ownLostSave) {
                sessionVersionRef.current = syncData.version;
                lastConfirmedResponsesRef.current = payload;
                if (generation === autosaveGenerationRef.current) {
                  const confirmedLocalSave = saveOfflineRecoveryRecord({
                    student: currentStudent,
                    examId: activeExam.id,
                    examTitle: activeExam.title,
                    userUuid: currentStudent.docId,
                    examData,
                    userResponses: payload,
                    activeSubject,
                    currentIndices,
                    version: syncData.version,
                    endTime: /** @type {number | undefined} */ (sessionEndTimeRef.current)
                  });
                  setLocalRecoveryAvailable(confirmedLocalSave.success);
                  setAutosaveStatus('SAVED');
                }
                return;
              }
              if (syncData?.conflict) {
                sessionVersionRef.current = syncData.version;
                if (generation === autosaveGenerationRef.current) {
                  if (syncData.user_responses) setUserResponses(syncData.user_responses);
                  setAutosaveStatus('CONFLICT');
                  setRecoveryNotice('A newer server-confirmed answer set was found, so this stale tab was not allowed to overwrite it. Review your answers before continuing.');
                }
                return;
              }
              throw new Error('The exam server returned an invalid autosave response.');
            } catch (err) {
              if (!isTransientRpcError(/** @type {import('../../types').RpcErrorLike} */ (err), { online: navigator.onLine }) || retry === 3) throw err;
            }
          }
        } catch (err) {
          console.warn("Autosave sync failed:", err);
          if (isStudentSessionReplaced(err)) {
            studentSessionLockedRef.current = true;
            setStudentSessionLocked(true);
            setAutosaveStatus('LOCKED');
            setRecoveryNotice(examActionErrorMessage(err, 'submit'));
            handleSafeLogout({ preserveAttempt: true });
            setTimeout(() => customAlert(examActionErrorMessage(err, 'submit')), 100);
            return;
          }
          const isNetworkIssue = isTransientRpcError(/** @type {import('../../types').RpcErrorLike} */ (err), { online: navigator.onLine });
          if (generation === autosaveGenerationRef.current) {
            setAutosaveStatus(isNetworkIssue && localSave.success ? 'OFFLINE' : 'FAILED');
          }
          if (!localSave.success && generation === autosaveGenerationRef.current) {
            setRecoveryNotice('This browser could not store a recovery copy. Keep this page open and restore the connection immediately.');
          }
        } finally {
          isSavingRef.current = false;
          if (pendingSaveRef.current) {
            const nextBatch = pendingSaveRef.current;
            pendingSaveRef.current = null;
            if (!sessionEndTimeRef.current || Date.now() < sessionEndTimeRef.current) {
              executeSave(nextBatch.payload, nextBatch.generation);
            }
          }
        }
      };

      executeSave(userResponses, saveGeneration);
    }, 1000);

    return () => clearTimeout(timer);
  }, [userResponses, examState, currentStudent, activeExam, examData, activeSubject, currentIndices, offlineSince, handleSafeLogout]);

  const terminateExam = useCallback(async () => {
    if (studentSessionLockedRef.current) return;
    setExamState('TERMINATED');
    clearLockdown();
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error(err));
    }

    if (currentStudent && activeExam) {
      try {
        const { error } = await supabase.rpc('terminate_exam', {
          exam_id_param: activeExam.id
        });
        if (error) throw error;
        clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam.id, userUuid: currentStudent.docId });
      } catch (err) {
        console.error("Failed to persist termination result:", err);
        if (isStudentSessionReplaced(err)) {
          studentSessionLockedRef.current = true;
          setStudentSessionLocked(true);
          handleSafeLogout({ preserveAttempt: true });
          setTimeout(() => customAlert(examActionErrorMessage(err, 'submit')), 100);
          return;
        }
        if (!savePendingTerminationRecord({
          student: currentStudent,
          examId: activeExam.id,
          userUuid: currentStudent.docId
        })) {
          console.error('Failed to cache pending termination: browser storage unavailable.');
        }
      }
    }
  }, [currentStudent, activeExam, handleSafeLogout, clearLockdown, setExamState]);

  useEffect(() => {
    terminateExamRef.current = terminateExam;
  }, [terminateExam]);

  const { subjectTimeRef, subjectTickRef, syncSubjectTime } = useSubjectTime({
    examState,
    activeSubject,
    activeExamId: activeExam?.id,
    currentStudent,
    lockdownActiveRef,
    initialSubjectTimeSeconds: initialActiveSession?.subjectTimeSeconds
  });

  // Auto-submit once when the fixed deadline passes. The deadline is derived
  // from the fixed end time, so sleep, background throttling, and a busy main
  // thread cannot give the candidate extra time.
  useEffect(() => {
    if (examState !== 'ACTIVE' || !isExamLocked) return;
    confirmSubmitExamRef.current?.();
  }, [examState, isExamLocked]);

  /** @param {ActiveExam} exam */
  const handleStartExamFlow = async (exam) => {
    warningsRef.current = 0;
    isAlertingRef.current = false;
    clearLockdown();
    subjectTimeRef.current = {};
    submissionStartedRef.current = false;
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
        jumbledQuestions[sub] = shuffleArray(subQuestions);
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
    if (studentSessionLockedRef.current) return;
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

      const localBaseVersion = Number(sessionVersionRef.current || 1);
      const authoritativeVersion = Number(session?.version || 1);
      sessionVersionRef.current = authoritativeVersion;
      const activeData = session?.jumbled_exam_data || examData;
      if (session?.jumbled_exam_data) setExamData(session.jumbled_exam_data);
      if (session?.user_responses) {
        if (localBaseVersion === authoritativeVersion) {
          setUserResponses(/** @type {ExamResponses} */ (mergeOfflineResponses(activeData, session.user_responses, userResponses)));
        } else {
          setUserResponses(session.user_responses);
          setRecoveryNotice('The server had newer confirmed progress. This device’s stale copy was not applied. Review your answers before continuing.');
        }
      }
      const remainingSeconds = session?.time_left !== undefined && session?.time_left !== null
        ? session.time_left
        : (examData.duration || 180) * 60;
      const calculatedEndTime = Date.now() + (remainingSeconds * 1000);
      sessionEndTimeRef.current = calculatedEndTime;
      setSessionEndTime(calculatedEndTime);

      // Pre-cache all question diagrams into browser memory
      preloadExamImages(activeData);

      // Start Exam after a server-owned session has been created or restored.
      setExamState('ACTIVE');
      subjectTickRef.current = Date.now();
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
    if (studentSessionLockedRef.current) return;
    setShowSubmitModal(true);
  }, []);

  const calculateResults = async () => {
    if (studentSessionLockedRef.current) {
      throw new Error('This student session has been replaced or is no longer active');
    }
    if (!currentStudent || !activeExam) {
      throw new Error('An active student and exam are required to submit.');
    }

    // Confirm the final visible answer state before submission so the private
    // administrator review snapshot and the grade are based on the same data.
    const deadlinePassed = sessionEndTimeRef.current && Date.now() >= sessionEndTimeRef.current;
    let mayAlreadyBeCommitted = false;
    let confirmedVersion = null;
    if (!deadlinePassed) {
      const { data: syncData, error: syncError } = await supabase.rpc('sync_active_session_progress', {
        exam_id_param: activeExam.id,
        responses_param: userResponses,
        expected_version_param: sessionVersionRef.current
      });
      // A successful first submission removes the active session. If its HTTP
      // response is lost, the retry must still reach the idempotent submit RPC
      // so it can return the already-committed result.
      mayAlreadyBeCommitted = /** @type {string[]} */ ([APP_ERROR.SESSION_NOT_FOUND, APP_ERROR.ALREADY_SUBMITTED]).includes(classifyAppError(syncError));
      if (syncError && !mayAlreadyBeCommitted) throw syncError;
      if (!syncError) {
        if (syncData?.conflict) {
          sessionVersionRef.current = syncData.version;
          if (syncData.user_responses) setUserResponses(syncData.user_responses);
          throw new Error('A newer server-confirmed answer set was found. Review the restored answers and submit again.');
        }
        if (!syncData?.success) throw new Error('The final answer save was not confirmed by the server.');
        sessionVersionRef.current = syncData.version;
        lastConfirmedResponsesRef.current = userResponses;
        confirmedVersion = syncData.version;
      }
    }
    if (!mayAlreadyBeCommitted) await syncSubjectTime();

    // The browser sends only question IDs and responses. Answer keys stay in
    // Supabase and are evaluated by the protected submit_exam RPC.
    const responses = buildSubmissionResponses(examData, userResponses);

    // With a confirmed version the server grades its own stored snapshot, so a
    // stale tab can never overwrite newer answers. Submission is idempotent, so
    // transient failures (rate limits, overload, lock timeouts) are retried.
    const submitArgs = {
      exam_id_param: activeExam.id,
      responses_param: responses,
      ...(confirmedVersion !== null ? { expected_version_param: confirmedVersion } : {})
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
    if (submissionStartedRef.current || studentSessionLockedRef.current) return;
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
      if (currentStudent && activeExam && examData) {
        const responses = buildSubmissionResponses(examData, userResponses);
        const pendingSave = savePendingSubmissionRecord({
          student: currentStudent,
          examId: activeExam.id,
          userUuid: currentStudent.docId,
          responses
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
    studentSessionLockedRef
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
    // Lockdown
    lockdownActive,
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
