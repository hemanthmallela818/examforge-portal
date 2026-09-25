import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { supabase } from './supabase';
import { LoadingBlock } from './components/ui';
import AuthPortal from './components/AuthPortal';
import CustomPopupContainer from './components/CustomPopupContainer';
import { safeStorageGet, safeStorageSet, safeStorageRemove } from './browserStorage';
import LiveAnnouncer from './components/LiveAnnouncer';
import ActiveExamView from './features/exam/ActiveExamView';
import { readStoredActiveSession, readStoredStudent } from './features/exam/examSessionHelpers';
import { useExamSession } from './features/exam/useExamSession';
import { refreshBranding } from './branding/brandingStore';

const AdminDashboard = lazy(() => import('./components/AdminDashboard'));
const StudentDashboard = lazy(() => import('./components/StudentDashboard'));
const PreExam = lazy(() => import('./components/PreExam'));
const Result = lazy(() => import('./components/Result'));
const Terminated = lazy(() => import('./components/Terminated'));

// Router/state shell: owns the screen (examState), the signed-in candidate and
// the displayed scorecard. The student exam session lives in useExamSession.
function App() {
  const initialStudent = useRef(readStoredStudent());
  const initialActiveSession = useRef(readStoredActiveSession(initialStudent.current));
  const [examState, setExamState] = useState(() => {
    if (initialActiveSession.current) return 'ACTIVE';
    const saved = safeStorageGet('sessionStorage', 'examState');
    if (saved === 'STUDENT_DASHBOARD') return saved;
    // Restore administrative screens only after server authorization.
    if (saved && saved !== 'AUTH' && saved !== 'ADMIN_DASHBOARD') {
      const isStudent = safeStorageGet('sessionStorage', 'currentStudent');
      return isStudent ? 'STUDENT_DASHBOARD' : 'AUTH';
    }
    return 'AUTH';
  });
  const [currentStudent, setCurrentStudent] = useState(initialStudent.current);
  const [results, setResults] = useState(/** @type {import('./features/exam/examSessionHelpers').Scorecard | null} */ (null));

  // Institution branding is public (shown before sign-in); refresh the cached copy.
  useEffect(() => {
    refreshBranding();
  }, []);

  // Asynchronously verify administrator session restoration on initial mount
  useEffect(() => {
    const saved = safeStorageGet('sessionStorage', 'examState');
    if (saved === 'ADMIN_DASHBOARD' || !initialStudent.current) {
      supabase.auth.getUser().then(async ({ data: { user }, error }) => {
        if (error || !user) {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
          return;
        }
        const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
        const { data: allowed, error: accessError } = await supabase.rpc('is_admin_aal2');
        if (profile?.role === 'admin' && !accessError && allowed === true) {
          setExamState('ADMIN_DASHBOARD');
        } else {
          safeStorageSet('sessionStorage', 'examState', 'AUTH');
        }
      });
    }
  }, []);

  // Browser storage never grants administrative authority.
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
        const { data: allowed, error: accessError } = await supabase.rpc('is_admin_aal2');
        if (accessError || allowed !== true) {
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

  // Mirror the top-level screen in the address bar. replaceState (not push):
  // these are not navigable history steps, and pushing them left stray "/"
  // entries that broke the Back button. The admin shell owns /admin/* history
  // itself, so an existing admin sub-path is kept.
  useEffect(() => {
    const replacePath = (/** @type {string} */ path) => {
      if (window.location.pathname !== path) window.history.replaceState(window.history.state, '', path);
    };
    if (examState === 'STUDENT_DASHBOARD') {
      replacePath('/dashboard');
    } else if (examState === 'ADMIN_DASHBOARD') {
      if (!window.location.pathname.startsWith('/admin')) replacePath('/admin');
    } else if (examState === 'ACTIVE') {
      replacePath('/exam');
    } else if (examState === 'AUTH') {
      replacePath('/');
    }
  }, [examState]);

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

  const session = useExamSession({
    examState,
    setExamState,
    currentStudent,
    setCurrentStudent,
    setResults,
    initialActiveSession: initialActiveSession.current
  });
  const { handleSafeLogout, handleStudentLogin, handleStartExamFlow, startExam, activeExam, examData } = session;
  const handleAdminBackToLogin = useCallback(() => setExamState('AUTH'), []);

  return (
    <>
      <LiveAnnouncer />
      <CustomPopupContainer />
      <Suspense fallback={<LoadingBlock label="Loading…" className="min-h-dvh bg-slate-50" />}>
      {examState === 'AUTH' && (
        <AuthPortal 
          onStudentLogin={handleStudentLogin}
          onAdminLogin={() => setExamState('ADMIN_DASHBOARD')}
        />
      )}
      {examState === 'STUDENT_DASHBOARD' && (
        <StudentDashboard 
          student={/** @type {import('./features/exam/examSessionHelpers').CurrentStudent} */ (currentStudent)}
          onLogout={handleSafeLogout}
          onStartExam={handleStartExamFlow}
          onViewResult={(/** @type {import('./features/exam/examSessionHelpers').Scorecard} */ scorecard) => {
            setResults(scorecard);
            setExamState('SUBMITTED');
          }}
        />
      )}
      {examState === 'ADMIN_DASHBOARD' && (
        <Suspense fallback={<LoadingBlock label="Loading administrator dashboard…" className="min-h-dvh bg-slate-50" />}>
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
        <ActiveExamView session={session} currentStudent={currentStudent} />
      )}
      </Suspense>
    </>
  );
}

export default App;
