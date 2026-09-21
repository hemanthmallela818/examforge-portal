import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { supabase } from './supabase';
import AuthPortal from './components/AuthPortal';
import CustomPopupContainer from './components/CustomPopupContainer';
import OfflineOverlay from './components/OfflineOverlay';
import { customAlert } from './utils';
import { safeStorageGet, safeStorageSet, safeStorageRemove, safeStorageJson } from './browserStorage';
import {
  buildSubmissionResponses,
  createInitialResponses,
  remainingSecondsUntil,
  sessionBelongsToStudent,
  saveOfflineRecoveryRecord,
  readOfflineRecoveryRecord,
  clearOfflineRecoveryRecord,
  mergeOfflineResponses,
  reconcileOfflineRecovery,
  RECOVERY_SCHEMA_VERSION,
  savePendingSubmissionRecord,
  readPendingSubmissionRecord,
  beginPendingSubmissionSync,
  finishPendingSubmissionSync,
  savePendingTerminationRecord,
  readPendingTerminationRecord,
  clearPendingTerminationRecord
} from './examLogic';

const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const StudentDashboard = lazy(() => import('./components/StudentDashboard'));
const PreExam = lazy(() => import('./components/PreExam'));
const ExamNavbar = lazy(() => import('./components/ExamNavbar'));
const QuestionPanel = lazy(() => import('./components/QuestionPanel'));
const GridPanel = lazy(() => import('./components/GridPanel'));
const Result = lazy(() => import('./components/Result'));
const Terminated = lazy(() => import('./components/Terminated'));
const AccessibleModal = lazy(() => import('./components/AccessibleModal'));
import { preloadExamImages } from './components/StorageImage';
import LiveAnnouncer, { announcePolite, announceAssertive } from './components/LiveAnnouncer';
const emptyExam = { subjects: [], questions: {} };

const readStoredSessionMirror = () => {
  try {
    const raw = safeStorageGet('localStorage', 'cbt_active_exam_session');
    if (!raw) return null;
    const session = JSON.parse(raw);
    if (session?.schemaVersion === RECOVERY_SCHEMA_VERSION && session?.activeExam && session?.endTime) return session;
  } catch {}
  return null;
};

const readStoredActiveSession = (student) => {
  const session = readStoredSessionMirror();
  return session?.endTime > Date.now() && sessionBelongsToStudent(session, student) ? session : null;
};

const readStoredStudent = () => {
  const student = safeStorageJson('sessionStorage', 'currentStudent');
  if (!student) {
    safeStorageRemove('sessionStorage', 'currentStudent');
    safeStorageSet('sessionStorage', 'examState', 'AUTH');
  }
  return student;
};

const isStudentSessionReplaced = (error) => (
  /student session has been replaced|no longer active/i.test(error?.message || '')
);

function examActionErrorMessage(error, action) {
  const message = error?.message || '';

  if (isStudentSessionReplaced(error)) {
    return 'This login was replaced by another device. Your recoverable exam work remains saved; sign in again only if you need to take over.';
  }
  if (/already been submitted/i.test(message)) return 'This exam has already been submitted.';
  if (/not assigned/i.test(message)) return 'This exam is not assigned to your class or section.';
  if (/not available/i.test(message)) return 'This exam is not currently available.';
  if (/time has expired|session has expired/i.test(message)) {
    return 'Your exam time has expired. Your attempt has been finalized.';
  }
  if (/not started correctly/i.test(message)) {
    return 'Your exam session is no longer valid. Return to the dashboard and contact the invigilator.';
  }
  if (/profile not found/i.test(message)) return 'Your student account is not set up correctly. Contact the invigilator.';
  if (/answer key not found/i.test(message)) return 'This exam cannot be submitted. Contact the invigilator immediately.';

  return action === 'start'
    ? 'Unable to reach the exam server. Check your connection and try again.'
    : 'Unable to submit to the exam server. Check your connection and submit again.';
}

function App() {
  const initialStudent = useRef(readStoredStudent());
  const initialActiveSession = useRef(readStoredActiveSession(initialStudent.current));
  const [activeExam, setActiveExam] = useState(() => initialActiveSession.current?.activeExam || null);
  const [examData, setExamData] = useState(() => initialActiveSession.current?.examData || emptyExam);
  const [examState, setExamState] = useState(() => {
    if (initialActiveSession.current) return 'ACTIVE';
    const saved = safeStorageGet('sessionStorage', 'examState');
    if (saved === 'STUDENT_DASHBOARD') return saved;
    // Never restore ADMIN_DASHBOARD synchronously without validating AAL2
    if (saved && saved !== 'AUTH' && saved !== 'ADMIN_DASHBOARD') {
      const isStudent = safeStorageGet('sessionStorage', 'currentStudent');
      return isStudent ? 'STUDENT_DASHBOARD' : 'AUTH';
    }
    return 'AUTH';
  });
  const [currentStudent, setCurrentStudent] = useState(initialStudent.current);
  const [activeSubject, setActiveSubject] = useState(() => initialActiveSession.current?.activeSubject || '');
  const [currentIndices, setCurrentIndices] = useState(() => initialActiveSession.current?.currentIndices || {});
  const [userResponses, setUserResponses] = useState(() => initialActiveSession.current?.userResponses || {});
  const [results, setResults] = useState(null);
  const [warningMsg, setWarningMsg] = useState('');
  const warningsRef = useRef(0);
  const isAlertingRef = useRef(false);
  const [offlineSince, setOfflineSince] = useState(null);
  const [offlineDismissed, setOfflineDismissed] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const submitButtonRef = useRef(null);
  const [timeLeft, setTimeLeft] = useState(() => {
    if (initialActiveSession.current?.endTime) {
      return Math.max(1, Math.floor((initialActiveSession.current.endTime - Date.now()) / 1000));
    }
    return null;
  });
  const sessionEndTimeRef = useRef(initialActiveSession.current?.endTime || null);
  const [submissionError, setSubmissionError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submissionStartedRef = useRef(false);
  const [autosaveStatus, setAutosaveStatus] = useState('SAVED');
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [localRecoveryAvailable, setLocalRecoveryAvailable] = useState(true);
  const sessionVersionRef = useRef(initialActiveSession.current?.version || 1);
  const isSavingRef = useRef(false);
  const pendingSaveRef = useRef(null);
  const autosaveGenerationRef = useRef(0);
  const safeLogoutRef = useRef(null);
  const studentSessionLockedRef = useRef(false);
  const [studentSessionLocked, setStudentSessionLocked] = useState(false);
  const isExamLocked = timeLeft !== null && timeLeft <= 0;

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
        if (/already been submitted/i.test(error.message || '')) {
          const { data: committedResult } = await supabase
            .from('student_results')
            .select('*')
            .eq('student_id', currentStudent.id)
            .eq('exam_id', examId)
            .single();
          if (committedResult) {
            clearOfflineRecoveryRecord({ student: currentStudent, examId, userUuid: currentStudent.docId });
            setResults({
              totalScore: committedResult.total_score,
              maxScore: committedResult.max_score,
              correct: committedResult.correct,
              incorrect: committedResult.incorrect,
              unattempted: committedResult.unattempted,
              subjectScores: committedResult.subject_scores
            });
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
  }, [activeExam, currentStudent]);

  // Asynchronously verify administrator session restoration on initial mount
  useEffect(() => {
    const saved = safeStorageGet('sessionStorage', 'examState');
    if (saved === 'ADMIN_DASHBOARD') {
      supabase.auth.getUser().then(async ({ data: { user }, error }) => {
        if (error || !user) {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
          return;
        }
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (profile?.role === 'admin' && aalData?.currentLevel === 'aal2') {
          setExamState('ADMIN_DASHBOARD');
        } else {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
        }
      });
    }
  }, []);

  // Guard admin dashboard state against unauthorized session storage manipulation or AAL downgrade
  useEffect(() => {
    if (examState === 'ADMIN_DASHBOARD') {
      supabase.auth.getUser().then(async ({ data: { user }, error }) => {
        if (error || !user) {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
          setExamState('AUTH');
          return;
        }
        const { data: profile, error: profileErr } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        if (profileErr || profile?.role !== 'admin') {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
          setExamState('AUTH');
          return;
        }
        const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalData?.currentLevel !== 'aal2') {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
          setExamState('AUTH');
        }
      });
    }
  }, [examState]);

  // Listen for external auth state changes (e.g., logout in another tab)
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        if (examState === 'ADMIN_DASHBOARD') {
          safeStorageRemove('sessionStorage', 'currentAdmin');
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
          setExamState('AUTH');
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [examState]);

  // Sync examState with browser URL path for Playwright checks
  useEffect(() => {
    if (examState === 'STUDENT_DASHBOARD') {
      window.history.pushState({}, '', '/dashboard');
    } else if (examState === 'ADMIN_DASHBOARD') {
      window.history.pushState({}, '', '/admin');
    } else if (examState === 'ACTIVE') {
      window.history.pushState({}, '', '/exam');
    } else if (examState === 'AUTH') {
      window.history.pushState({}, '', '/');
    }
  }, [examState]);

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

  const handleReturnToExam = async () => {
    setWarningMsg('');
    isAlertingRef.current = false;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      console.warn("Fullscreen request on return failed:", err);
    }
  };

  const handleSafeLogout = useCallback((options = {}) => {
    const preserveAttempt = options?.preserveAttempt === true;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(err => console.error(err));
    }
    if (!preserveAttempt) safeStorageRemove('localStorage', 'cbt_active_exam_session');
    safeStorageRemove('localStorage', 'examSessionToken');
    safeStorageRemove('sessionStorage', 'currentStudent');
    safeStorageSet('sessionStorage', 'examState', 'AUTH');
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
  }, []);
  const handleAdminBackToLogin = useCallback(() => setExamState('AUTH'), []);
  safeLogoutRef.current = handleSafeLogout;

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

  useEffect(() => {
    safeStorageSet('sessionStorage', 'examState', examState);
  }, [examState]);

  useEffect(() => {
    if (currentStudent) {
      safeStorageSet('sessionStorage', 'currentStudent', JSON.stringify(currentStudent));
    } else {
      safeStorageRemove('sessionStorage', 'currentStudent');
    }
  }, [currentStudent]);

  // Session hijacking listener (Supabase Realtime)
  useEffect(() => {
    if (!currentStudent || !currentStudent.docId || examState === 'AUTH') return;

    // Check if docId is a valid UUID to prevent query exceptions for mock students
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(currentStudent.docId);
    if (!isUuid) return;
    
    const channel = supabase
      .channel(`student-session-${currentStudent.docId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'students',
        filter: `id=eq.${currentStudent.docId}`
      }, (payload) => {
        const data = payload.new;
        const currentLocalToken = safeStorageGet('localStorage', 'examSessionToken') || currentStudent.sessionToken;
        if (data.active_auth_session_id !== currentLocalToken) {
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
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentStudent, examState, handleSafeLogout]);

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
      endTime: sessionEndTimeRef.current
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

    // A changed response is not server-confirmed until the debounced RPC succeeds.
    // Mark it pending immediately so the UI never presents stale "saved" state.
    setAutosaveStatus('SAVING');

    const timer = setTimeout(async () => {
      if (isSavingRef.current) {
        pendingSaveRef.current = { payload: userResponses, generation: saveGeneration };
        return;
      }

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
              const delay = Math.min(1000 * Math.pow(2, retry - 1) + Math.random() * 200, 5000);
              await new Promise(resolve => setTimeout(resolve, delay));
            }

            try {
              const { data: syncData, error: syncError } = await supabase.rpc('sync_active_session_progress', {
                exam_id_param: activeExam.id,
                responses_param: payload,
                expected_version_param: sessionVersionRef.current
              });
              if (syncError) throw syncError;

              if (syncData?.success) {
                sessionVersionRef.current = syncData.version;
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
                    endTime: sessionEndTimeRef.current
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
              const isNetworkIssue = !navigator.onLine || /network|fetch|timeout|connection/i.test(err?.message || '');
              if (!isNetworkIssue || retry === 3) throw err;
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
          const isNetworkIssue = !navigator.onLine || /network|fetch|timeout|connection/i.test(err?.message || '');
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
    setWarningMsg(null);
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
  }, [currentStudent, activeExam, handleSafeLogout]);

  const terminateExamRef = useRef();
  useEffect(() => {
    terminateExamRef.current = terminateExam;
  }, [terminateExam]);

  // Security Traps Setup
  useEffect(() => {
    if (examState !== 'ACTIVE') return;

    const handleViolation = (message) => {
      if (isAlertingRef.current) return;

      // A browser focus event can be caused by an operating-system notification
      // or accessibility tool. Require three verified violations before ending
      // an attempt; the server-side time limit remains authoritative.
      if (warningsRef.current < 2) {
        warningsRef.current += 1;
        isAlertingRef.current = true;
        setWarningMsg(`${message} Warning ${warningsRef.current} of 3.`);
      } else {
        if (terminateExamRef.current) {
          terminateExamRef.current();
        }
      }
    };

    const handleKeyDown = (e) => {
      // Do not block ordinary typing: numerical-answer inputs must remain
      // usable. Allow candidate exam navigation shortcuts:
      // Alt+S, Alt+M, Alt+C, Alt+N, Alt+P, Ctrl+Enter, ArrowLeft, ArrowRight
      const isExamShortcut = 
        (e.altKey && ['s', 'S', 'm', 'M', 'c', 'C', 'n', 'N', 'p', 'P'].includes(e.key)) ||
        (e.ctrlKey && e.key === 'Enter');

      if (isExamShortcut) {
        return; // Allow QuestionPanel to handle the candidate exam shortcut
      }

      const blockedKeys = ['F5', 'F11', 'F12', 'PrintScreen'];
      if (e.ctrlKey || e.metaKey || e.altKey || blockedKeys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleViolation("Right-click is disabled during the exam.");
    };

    let blurTimeout;
    const handleBlur = () => {
      blurTimeout = setTimeout(() => {
        // A native notification or antivirus prompt blurs the window without
        // hiding the document. Treat only an actual hidden page as a violation.
        if (document.visibilityState === 'hidden') {
          handleViolation("You navigated away from the exam window.");
        }
      }, 1500);
    };
    const handleFocus = () => {
      clearTimeout(blurTimeout);
    };

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) {
        handleViolation("You exited fullscreen mode.");
      }
    };

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
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('contextmenu', handleContextMenu, { capture: true });
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      clearTimeout(blurTimeout);
    };
  }, [examState]);

  const confirmSubmitExamRef = useRef();

  // Derive the display from the fixed end time so sleep, background throttling,
  // and a busy main thread cannot give the candidate extra visible time.
  useEffect(() => {
    if (examState !== 'ACTIVE' || !sessionEndTimeRef.current) return;

    let timeoutTriggered = false;
    const tick = () => {
      const remaining = remainingSecondsUntil(sessionEndTimeRef.current);
      setTimeLeft(remaining);
      if (remaining === 0 && !timeoutTriggered) {
        timeoutTriggered = true;
        confirmSubmitExamRef.current?.();
      }
    };
    tick();
    const timerId = setInterval(tick, 1000);

    return () => clearInterval(timerId);
  }, [examState]);

  // Helper to randomly shuffle an array (Fisher-Yates shuffle)
  const shuffleArray = (arr) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const handleStartExamFlow = async (exam) => {
    warningsRef.current = 0;
    isAlertingRef.current = false;
    setWarningMsg('');
    submissionStartedRef.current = false;
    setActiveExam(exam);
    const data = exam.questionsData || exam.questions_data || { subjects: [], questions: {} };

    let restoredResponses = null;
    let restoredExamData = null;
    let restoredTimeLeft = null;
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
          restoredTimeLeft = sessionData.time_left;
          serverVersion = Number(sessionData.version || 1);
          sessionVersionRef.current = serverVersion;
        }
      } catch (err) {
        console.error("Failed to restore session from server", err);
      }
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
          if (local.endTime) {
            restoredTimeLeft = Math.max(0, Math.floor((local.endTime - Date.now()) / 1000));
          }
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
    const firstSub = finalExamData.subjects?.[0] || 'Physics';
    setActiveSubject(firstSub);
    
    const indices = {};
    (finalExamData.subjects || []).forEach(sub => { indices[sub] = 0; });
    setCurrentIndices(indices);

    if (restoredResponses && restoredExamData) {
      setUserResponses(restoredResponses);
      setTimeLeft(restoredTimeLeft !== undefined && restoredTimeLeft !== null ? restoredTimeLeft : (finalExamData.duration || 180) * 60);
    } else {
      const initialState = createInitialResponses(finalExamData);
      setUserResponses(initialState);
      setTimeLeft((finalExamData.duration || 180) * 60);
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
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen could not be enabled:', err);
    }

    try {
      const { data: session, error } = await supabase.rpc('start_exam_session', {
        exam_id_param: activeExam.id,
        exam_data_param: examData,
        responses_param: userResponses
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
          setResults({
            totalScore: committedResult.total_score,
            maxScore: committedResult.max_score,
            correct: committedResult.correct,
            incorrect: committedResult.incorrect,
            unattempted: committedResult.unattempted,
            subjectScores: committedResult.subject_scores
          });
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
          setUserResponses(mergeOfflineResponses(activeData, session.user_responses, userResponses));
        } else {
          setUserResponses(session.user_responses);
          setRecoveryNotice('The server had newer confirmed progress. This device’s stale copy was not applied. Review your answers before continuing.');
        }
      }
      const remainingSeconds = session?.time_left !== undefined && session?.time_left !== null
        ? session.time_left
        : (examData.duration || 180) * 60;
      setTimeLeft(remainingSeconds);
      const calculatedEndTime = Date.now() + (remainingSeconds * 1000);
      sessionEndTimeRef.current = calculatedEndTime;

      // Pre-cache all question diagrams into browser memory
      preloadExamImages(activeData);

      // Start Exam after a server-owned session has been created or restored.
      setExamState('ACTIVE');
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

  const submitExam = () => {
    if (studentSessionLockedRef.current) return;
    setShowSubmitModal(true);
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
      if (/already been submitted/i.test(err?.message || '')) {
        const { data: committedResult } = await supabase
          .from('student_results')
          .select('*')
          .eq('student_id', currentStudent.id)
          .eq('exam_id', activeExam?.id)
          .single();
        if (committedResult) {
          clearOfflineRecoveryRecord({ student: currentStudent, examId: activeExam?.id, userUuid: currentStudent?.docId });
          setResults({
            totalScore: committedResult.total_score,
            maxScore: committedResult.max_score,
            correct: committedResult.correct,
            incorrect: committedResult.incorrect,
            unattempted: committedResult.unattempted,
            subjectScores: committedResult.subject_scores
          });
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

  const calculateResults = async () => {
    if (studentSessionLockedRef.current) {
      throw new Error('This student session has been replaced or is no longer active');
    }
    if (!currentStudent || !activeExam) {
      throw new Error('An active student and exam are required to submit.');
    }

    // The browser sends only question IDs and responses. Answer keys stay in
    // Supabase and are evaluated by the protected submit_exam RPC.
    const responses = buildSubmissionResponses(examData, userResponses);

    const { data: finalResults, error } = await supabase.rpc('submit_exam', {
      exam_id_param: activeExam.id,
      responses_param: responses
    });
    if (error) {
      console.error('Failed to save result to Supabase:', error);
      throw error;
    }

    setResults(finalResults);
  };

  const handleAction = (actionType) => {
    if (studentSessionLockedRef.current) return;
    const currentIndex = currentIndices[activeSubject] || 0;
    const currentResponse = userResponses?.[activeSubject]?.[currentIndex] || { selectedOption: null, status: 'NOT_VISITED' };
    
    let newStatus = currentResponse.status;
    const hasOption = currentResponse.selectedOption !== null && currentResponse.selectedOption !== undefined && currentResponse.selectedOption !== '';

    if (actionType === 'SAVE_NEXT') {
      newStatus = hasOption ? 'ANSWERED' : 'NOT_ANSWERED';
    } else if (actionType === 'SAVE_MARK') {
      newStatus = hasOption ? 'ANSWERED_MARKED' : 'MARKED';
    } else if (actionType === 'MARK_NEXT') {
      newStatus = hasOption ? 'ANSWERED_MARKED' : 'MARKED';
    }

    updateResponse(currentIndex, currentResponse.selectedOption, newStatus);
    goNext();
  };

  const updateResponse = (index, selectedOption, status) => {
    if (studentSessionLockedRef.current) return;
    setAutosaveStatus(navigator.onLine && !offlineSince ? 'SAVING' : 'OFFLINE');
    setUserResponses(prev => {
      if (!prev[activeSubject]) return prev;
      const newResponses = { ...prev };
      newResponses[activeSubject] = [...newResponses[activeSubject]];
      newResponses[activeSubject][index] = { selectedOption, status };
      return newResponses;
    });
  };

  const selectResponse = (index, selectedOption) => {
    if (studentSessionLockedRef.current) return;
    setAutosaveStatus(navigator.onLine && !offlineSince ? 'SAVING' : 'OFFLINE');
    setUserResponses(prev => {
      if (!prev[activeSubject] || !prev[activeSubject][index]) return prev;
      const currentResponse = prev[activeSubject][index];
      let status = currentResponse.status;

      if (selectedOption === null || selectedOption === '') {
        status = status === 'ANSWERED_MARKED' ? 'MARKED' : 'NOT_ANSWERED';
      } else if (status === 'MARKED' || status === 'ANSWERED_MARKED') {
        status = 'ANSWERED_MARKED';
      } else {
        status = 'ANSWERED';
      }

      const newResponses = { ...prev };
      newResponses[activeSubject] = [...newResponses[activeSubject]];
      newResponses[activeSubject][index] = { selectedOption, status };
      return newResponses;
    });
  };

  const changeSubjectAndIndex = (newSubject, newIndex) => {
    setActiveSubject(newSubject);
    setCurrentIndices(prev => ({ ...prev, [newSubject]: newIndex }));
    announcePolite(`Switched to ${newSubject} section, Question ${newIndex + 1}.`);
    
    setUserResponses(prev => {
      if (!prev[newSubject] || !prev[newSubject][newIndex]) return prev;
      const currentStatus = prev[newSubject][newIndex].status;
      if (currentStatus === 'NOT_VISITED') {
        const newResponses = { ...prev };
        newResponses[newSubject] = [...newResponses[newSubject]];
        newResponses[newSubject][newIndex] = { 
          ...newResponses[newSubject][newIndex], 
          status: 'NOT_ANSWERED' 
        };
        return newResponses;
      }
      return prev;
    });
  };

  const goNext = () => {
    const currentIndex = currentIndices[activeSubject] || 0;
    const subQuestions = examData?.questions?.[activeSubject] || [];
    if (currentIndex < subQuestions.length - 1) {
      changeQuestion(currentIndex + 1);
    } else {
      const subjectIndex = examData?.subjects ? examData.subjects.indexOf(activeSubject) : -1;
      if (subjectIndex >= 0 && subjectIndex < (examData?.subjects?.length || 0) - 1) {
        changeSubjectAndIndex(examData.subjects[subjectIndex + 1], 0);
      }
    }
  };

  const goPrev = () => {
    const currentIndex = currentIndices[activeSubject] || 0;
    if (currentIndex > 0) {
      changeQuestion(currentIndex - 1);
    } else {
      const subjectIndex = examData?.subjects ? examData.subjects.indexOf(activeSubject) : -1;
      if (subjectIndex > 0) {
        const prevSubject = examData.subjects[subjectIndex - 1];
        const prevSubQuestions = examData?.questions?.[prevSubject] || [];
        const lastIndex = Math.max(0, prevSubQuestions.length - 1);
        changeSubjectAndIndex(prevSubject, lastIndex);
      }
    }
  };

  const changeQuestion = (newIndex) => {
    setCurrentIndices(prev => ({ ...prev, [activeSubject]: newIndex }));
    
    // If the new question is NOT_VISITED, change it to NOT_ANSWERED
    setUserResponses(prev => {
      if (!prev[activeSubject] || !prev[activeSubject][newIndex]) return prev;
      if (prev[activeSubject][newIndex].status === 'NOT_VISITED') {
        const newResponses = { ...prev };
        newResponses[activeSubject] = [...newResponses[activeSubject]];
        newResponses[activeSubject][newIndex] = { 
          ...newResponses[activeSubject][newIndex], 
          status: 'NOT_ANSWERED' 
        };
        return newResponses;
      }
      return prev;
    });
  };

  const handleSubjectChange = (sub) => {
    setActiveSubject(sub);
    const firstIndex = currentIndices[sub] || 0;
    setUserResponses(prev => {
      if (!prev[sub] || !prev[sub][firstIndex]) return prev;
      if (prev[sub][firstIndex].status === 'NOT_VISITED') {
        const newResponses = { ...prev };
        newResponses[sub] = [...newResponses[sub]];
        newResponses[sub][firstIndex] = { ...newResponses[sub][firstIndex], status: 'NOT_ANSWERED' };
        return newResponses;
      }
      return prev;
    });
  };

  const currentQIndex = currentIndices[activeSubject] || 0;
  const currentQuestion = examData?.questions?.[activeSubject] ? examData.questions[activeSubject][currentQIndex] : null;
  const currentResponse = userResponses?.[activeSubject] ? userResponses[activeSubject][currentQIndex] : { selectedOption: null, status: 'NOT_VISITED' };
  const totalSubQuestions = examData?.questions?.[activeSubject] ? examData.questions[activeSubject].length : 0;

  const subjectIndex = examData?.subjects ? examData.subjects.indexOf(activeSubject) : -1;
  const isFirstQuestionOfExam = subjectIndex === 0 && currentQIndex === 0;
  const isLastQuestionOfExam = examData?.subjects && subjectIndex === examData.subjects.length - 1 && currentQIndex === totalSubQuestions - 1;

  return (
    <>
      <LiveAnnouncer />
      <CustomPopupContainer />
      <Suspense fallback={<div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>Loading…</div>}>
      {examState === 'AUTH' && (
        <AuthPortal 
          onStudentLogin={(student) => {
            studentSessionLockedRef.current = false;
            setStudentSessionLocked(false);
            setCurrentStudent(student);
            setExamState('STUDENT_DASHBOARD');
          }}
          onAdminLogin={() => setExamState('ADMIN_DASHBOARD')}
        />
      )}
      {examState === 'STUDENT_DASHBOARD' && (
        <StudentDashboard 
          student={currentStudent}
          onLogout={handleSafeLogout}
          onStartExam={handleStartExamFlow}
          onViewResult={(scorecard) => {
            setResults(scorecard);
            setExamState('SUBMITTED');
          }}
        />
      )}
      {examState === 'ADMIN_DASHBOARD' && (
        <Suspense fallback={<div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>Loading administrator dashboard…</div>}>
          <AdminDashboard onBackToLogin={handleAdminBackToLogin} />
        </Suspense>
      )}
      {examState === 'PRE_EXAM' && (
        <PreExam
          startExam={startExam}
          activeExamId={activeExam?.id}
          duration={examData?.duration}
          marksCorrect={examData?.marksCorrect}
          marksIncorrect={examData?.marksIncorrect}
          subjects={examData?.subjects}
        />
      )}
      {examState === 'TERMINATED' && (
        <Terminated onBackToDashboard={() => setExamState(currentStudent ? 'STUDENT_DASHBOARD' : 'AUTH')} />
      )}
      {examState === 'SUBMITTED' && (
        <Result results={results} onBackToDashboard={() => setExamState(currentStudent ? 'STUDENT_DASHBOARD' : 'AUTH')} />
      )}
      {examState === 'ACTIVE' && (
        <div className="active-exam-shell" style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
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
            <div style={{
              backgroundColor: '#b91c1c',
              color: 'white',
              padding: '8px 16px',
              fontSize: '0.88rem',
              textAlign: 'center',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '14px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              zIndex: 100
            }}>
              <span>{localRecoveryAvailable
                ? '📵 Offline Mode Active: You can continue answering. Responses are being saved on this device.'
                : '⚠️ Offline recovery storage failed. Reconnect immediately and keep this page open.'}</span>
              <button
                onClick={() => setOfflineDismissed(false)}
                style={{
                  backgroundColor: 'rgba(255,255,255,0.25)',
                  border: '1px solid white',
                  color: 'white',
                  borderRadius: '4px',
                  padding: '3px 10px',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  fontWeight: 'bold'
                }}
              >
                Network Status
              </button>
            </div>
          )}
          {warningMsg && (
            <AccessibleModal labelledBy="security-warning-title" maxWidth="500px">
                  <h2 id="security-warning-title" style={{ color: 'var(--danger)', marginBottom: '20px', fontSize: '1.8rem', fontWeight: 'bold' }}>⚠️ SECURITY WARNING ⚠️</h2>
                  <p style={{ marginBottom: '15px', fontSize: '1.2rem', color: 'var(--text-main)' }}>{warningMsg}</p>
                  <p style={{ marginBottom: '25px', fontWeight: 'bold', color: 'var(--danger)' }}>Return to the exam immediately. A third verified violation will end the attempt.</p>
                  <button data-modal-autofocus className="btn-primary" onClick={handleReturnToExam} style={{ fontSize: '1.1rem', padding: '12px 24px' }}>
                    I Understand - Return to Exam
                  </button>
            </AccessibleModal>
          )}
          {showSubmitModal && (
            <AccessibleModal labelledBy="submit-exam-title" onEscape={() => !isSubmitting && setShowSubmitModal(false)} returnFocusRef={submitButtonRef} maxWidth="400px">
                  <h2 id="submit-exam-title" style={{ color: 'var(--text-main)', marginBottom: '20px', fontSize: '1.5rem', fontWeight: 'bold' }}>Submit Exam?</h2>
                  <p style={{ marginBottom: '25px', fontSize: '1.1rem', color: 'var(--text-muted)' }}>Are you sure you want to submit your exam? You will not be able to change your answers.</p>
                  <div style={{ display: 'flex', gap: '15px', justifyContent: 'center' }}>
                    <button data-modal-autofocus className="btn-outline" onClick={() => setShowSubmitModal(false)} style={{ padding: '10px 20px', flex: 1 }}>
                      Cancel
                    </button>
                    <button className="btn-primary" onClick={confirmSubmitExam} disabled={isSubmitting || studentSessionLocked} style={{ padding: '10px 20px', backgroundColor: 'var(--success)', border: 'none', flex: 1 }}>
                      {isSubmitting ? 'Submitting…' : 'Yes, Submit'}
                    </button>
                  </div>
            </AccessibleModal>
          )}

          {submissionError && (
            <div style={{ position: 'fixed', top: '80px', left: '50%', transform: 'translateX(-50%)', zIndex: 10001, backgroundColor: '#fef2f2', border: '2px solid #ef4444', borderRadius: '10px', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: '20px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
              <div style={{ color: '#991b1b', fontWeight: 'bold', fontSize: '1rem' }}>
                ⚠️ {submissionError}
              </div>
              <button
                onClick={confirmSubmitExam}
                disabled={isSubmitting || studentSessionLocked}
                className="btn-primary"
                style={{ backgroundColor: '#dc2626', padding: '8px 18px', fontSize: '0.9rem', cursor: 'pointer', whiteSpace: 'nowrap' }}
              >
                {isSubmitting ? 'Submitting...' : '🔄 Retry Submit Exam'}
              </button>
            </div>
          )}

          {recoveryNotice && (
            <div role="status" style={{ backgroundColor: '#7c2d12', color: 'white', padding: '10px 20px', fontSize: '0.9rem', fontWeight: 'bold', textAlign: 'center', zIndex: 101 }}>
              ⚠️ {recoveryNotice}
              <button type="button" onClick={() => setRecoveryNotice('')} style={{ marginLeft: '14px', border: '1px solid white', borderRadius: '4px', background: 'transparent', color: 'white', padding: '2px 8px', cursor: 'pointer' }}>Dismiss</button>
            </div>
          )}

          {isExamLocked && (
            <div style={{
              backgroundColor: '#e11d48',
              color: 'white',
              padding: '10px 20px',
              fontSize: '0.95rem',
              fontWeight: 'bold',
              textAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
              zIndex: 100
            }}>
              <span>⏰ Examination Time Has Concluded. Answers are locked. Submitting responses to server...</span>
            </div>
          )}

          <ExamNavbar 
            subjects={examData.subjects} 
            activeSubject={activeSubject} 
            setActiveSubject={handleSubjectChange} 
            studentName={currentStudent?.name}
            examTitle={activeExam?.title}
            duration={examData.duration ?? 180}
            paused={false}
            onTimeOut={confirmSubmitExam}
            timeLeft={timeLeft}
            autosaveStatus={autosaveStatus}
          />
          <div className="active-exam-content" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            <QuestionPanel 
              question={currentQuestion}
              questionIndex={currentQIndex}
              selectedOption={currentResponse.selectedOption}
              setSelectedOption={(val) => selectResponse(currentQIndex, val)}
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
            <GridPanel 
              totalQuestions={totalSubQuestions}
              questionStatuses={userResponses[activeSubject] ? userResponses[activeSubject].map(r => r.status) : []}
              currentQuestionIndex={currentQIndex}
              setCurrentQuestionIndex={changeQuestion}
            />
          </div>
        </div>
      )}
      </Suspense>
    </>
  );
}

export default App;
