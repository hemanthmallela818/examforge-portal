import { useEffect, useState } from 'react';
import { Loader2, Lock, RotateCcw } from 'lucide-react';
import { Button, Card, CardContent, cn } from './ui';
import { supabase } from '../supabase';
import { safeStorageRemove } from '../browserStorage';
import ReviewedJsonImporter from './AIQuestionImporter';
import AdminOperationsView from './AdminOperationsView';
import AdminDatabaseCleanerView from './AdminDatabaseCleanerView';
import SubjectsAndPatternsView from './SubjectsAndPatternsView';
import SettingsView from '../features/admin/settings/SettingsView';
import AdminProvider from '../features/admin/AdminProvider';
import AdminShell from '../features/admin/AdminShell';
import { useAdminContext } from '../features/admin/adminContext';
import { useAdminRoute } from '../features/admin/routing/useAdminRoute';
import { useAdminRealtime } from '../features/admin/shared/useAdminRealtime';
import { useClassesOnDemand } from '../features/admin/classes/useClasses';
import ClassesView from '../features/admin/classes/ClassesView';
import { useExams } from '../features/admin/overview/useExams';
import ExamOverview from '../features/admin/overview/ExamOverview';
import { useExamDetail } from '../features/admin/exams/useExamDetail';
import { useResultExports } from '../features/admin/exams/useResultExports';
import { useExamActions } from '../features/admin/exams/useExamActions';
import ExamDetailView from '../features/admin/exams/ExamDetailView';
import { useStudentRoster } from '../features/admin/students/useStudentRoster';
import StudentsView from '../features/admin/students/StudentsView';
import { useQuestionBank } from '../features/admin/questions/useQuestionBank';
import { useExamBuilder } from '../features/admin/questions/useExamBuilder';
import QuestionBankView from '../features/admin/questions/QuestionBankView';
import { useOperations } from '../features/admin/maintenance/useOperations';
import { useMaintenanceActions } from '../features/admin/maintenance/useMaintenanceActions';
import { formatBytes } from '../features/admin/maintenance/formatBytes';

/** @type {Partial<Record<import('../features/admin/routing/adminRoutes').AdminTab, string>>} */
const PAGE_TITLES = {
  STUDENTS: 'Student Management',
  CLASSES: 'Class Management',
  SUBJECTS: 'Subjects & Exam Patterns',
  QUESTION_BANK: 'Question Bank',
  AI_IMPORTER: 'Reviewed JSON Import',
  OPERATIONS: 'Operations & Audit',
  DB_CLEANER: 'Database Maintenance & Cleaner',
  SETTINGS: 'Settings'
};

/**
 * The administrator workspace: tab routing (/admin/*), feature hooks and the
 * active screen inside AdminShell. Mounted only once access is granted.
 * @param {{ onBackToLogin: () => void }} props
 */
function AdminWorkspace({ onBackToLogin }) {
  const {
    dataLoadState,
    loadedCollections,
    isRootDeveloper,
    tableCounts,
    dbSize,
    fetchTableCounts,
    scheduleTableCounts,
    classBook,
    catalog
  } = useAdminContext();
  const { activeTab, activeExamId, navigate } = useAdminRoute();

  // Collection loaders run only while their owning screen is open.
  const overviewEnabled = activeTab === 'DASHBOARD' && !activeExamId;
  const studentsEnabled = !activeExamId && activeTab === 'STUDENTS';
  const questionBankEnabled = !activeExamId && (activeTab === 'QUESTION_BANK' || activeTab === 'AI_IMPORTER');
  const classesEnabled = studentsEnabled || questionBankEnabled || (!activeExamId && activeTab === 'CLASSES');

  const examList = useExams({ enabled: overviewEnabled });
  const examDetail = useExamDetail({ activeExamId });
  const resultExports = useResultExports({ fetchResults: examDetail.fetchResults });
  const examActions = useExamActions({
    examList,
    examDetail,
    onExamDeleted: () => navigate({ tab: 'DASHBOARD' }, { replace: true })
  });
  const roster = useStudentRoster({ enabled: studentsEnabled });
  useClassesOnDemand(classesEnabled);
  const questionBankState = useQuestionBank({ enabled: questionBankEnabled });
  const examBuilder = useExamBuilder({
    selectedQuestions: questionBankState.selectedQuestions,
    setSelectedQuestions: questionBankState.setSelectedQuestions,
    onExamCreated: () => {
      examList.resetExamListQuery();
      navigate({ tab: 'DASHBOARD' });
    }
  });
  const operations = useOperations({ enabled: activeTab === 'OPERATIONS' });
  const { fetchOperationalOverview } = operations;
  const { handleClearTable, handleDeleteAllQuestions, handleResetApplicationData, isResettingApplication } = useMaintenanceActions({
    fetchExams: examList.fetchExams,
    fetchResults: examDetail.fetchResults,
    fetchStudents: roster.fetchStudents,
    fetchQuestionBank: questionBankState.fetchQuestionBank,
    fetchOperationalOverview,
    onApplicationReset: () => {
      if (activeExamId) navigate({ tab: activeTab }, { replace: true });
      examDetail.clearExamDetailState();
      questionBankState.setSelectedQuestions([]);
    }
  });

  useAdminRealtime({
    loadedCollections,
    fetchTableCounts,
    scheduleTableCounts,
    fetchExams: examList.fetchExams,
    fetchExamDetail: examDetail.fetchExamDetail,
    fetchResults: examDetail.fetchResults,
    activeExamIdRef: examDetail.activeExamIdRef,
    fetchStudents: roster.fetchStudents,
    studentsListRef: roster.studentsListRef,
    locallyAddedStudents: roster.locallyAddedStudents,
    fetchQuestionBank: questionBankState.fetchQuestionBank,
    fetchClasses: classBook.fetchClasses
  });

  const failedDataLoads = /** @type {Array<[string, import('../types').DataLoadEntry]>} */ (Object.entries(dataLoadState).filter(([, state]) => state?.error));
  const isAnyDataLoading = Object.values(dataLoadState).some(state => state?.loading);

  const retryFailedDataLoads = async () => {
    const retries = failedDataLoads.map(([key]) => {
      if (key === 'counts') return fetchTableCounts();
      if (key === 'exams') return examList.fetchExams();
      if (key === 'examDetail') return activeExamId ? examDetail.fetchExamDetail(activeExamId) : Promise.resolve(true);
      if (key === 'results') return activeExamId ? examDetail.fetchResults(activeExamId) : Promise.resolve(true);
      if (key === 'students') return roster.fetchStudents();
      if (key === 'questions') return questionBankState.fetchQuestionBank();
      if (key === 'classes') return classBook.fetchClasses();
      return Promise.resolve(true);
    });
    await Promise.all(retries);
  };

  const pageTitle = PAGE_TITLES[activeTab] || (activeExamId ? 'Exam Management' : 'Dashboard Overview');

  const renderActiveScreen = () => {
    switch (activeTab) {
      case 'STUDENTS':
        return <StudentsView roster={roster} />;
      case 'CLASSES':
        return <ClassesView />;
      case 'SUBJECTS':
        return (
          <SubjectsAndPatternsView
            subjects={catalog.subjectCatalog}
            templates={catalog.examTemplates}
            loading={catalog.catalogState.loading}
            error={catalog.catalogState.error}
            onReload={catalog.fetchSubjectCatalog}
          />
        );
      case 'QUESTION_BANK':
        return <QuestionBankView questionBankState={questionBankState} examBuilder={examBuilder} onDeleteAllQuestions={handleDeleteAllQuestions} />;
      case 'AI_IMPORTER':
        return <ReviewedJsonImporter questionBank={questionBankState.questionBank} refreshQuestionBank={questionBankState.fetchQuestionBank} allowedSubjects={catalog.activeSubjectNames} />;
      case 'OPERATIONS':
        return (
          <AdminOperationsView
            operationalHealth={operations.operationalHealth}
            operationalLoading={operations.operationalLoading}
            operationalError={operations.operationalError}
            onRefresh={fetchOperationalOverview}
            unreferencedAssets={operations.unreferencedAssets}
            scanningAssets={operations.scanningAssets}
            cleaningAssets={operations.cleaningAssets}
            onScanAssets={operations.handleScanUnreferencedAssets}
            onCleanupAssets={operations.handleCleanupUnreferencedAssets}
            auditEvents={operations.auditEvents}
            clientErrors={operations.clientErrors}
          />
        );
      case 'DB_CLEANER':
        return (
          <AdminDatabaseCleanerView
            dbSize={dbSize}
            formatBytes={formatBytes}
            tableCounts={tableCounts}
            onMaintainTable={handleClearTable}
            isRootDeveloper={isRootDeveloper}
            onResetApplication={handleResetApplicationData}
            isResetting={isResettingApplication}
          />
        );
      case 'SETTINGS':
        return <SettingsView isRootDeveloper={isRootDeveloper} />;
      default:
        return activeExamId ? (
          <ExamDetailView
            examDetail={examDetail}
            resultExports={resultExports}
            examActions={examActions}
            onBack={() => navigate({ tab: 'DASHBOARD' })}
          />
        ) : (
          <ExamOverview
            examList={examList}
            onManageExam={examId => navigate({ tab: 'DASHBOARD', examId })}
            onDeleteExam={examActions.handleDeleteExam}
            onGoToQuestionBank={() => navigate({ tab: 'QUESTION_BANK' })}
          />
        );
    }
  };

  return (
    <AdminShell
      activeTab={activeTab}
      activeExamId={activeExamId}
      pageTitle={pageTitle}
      onNavigate={navigate}
      onBackToLogin={onBackToLogin}
      failedDataLoads={failedDataLoads}
      isAnyDataLoading={isAnyDataLoading}
      onRetryFailedDataLoads={retryFailedDataLoads}
    >
      {renderActiveScreen()}
    </AdminShell>
  );
}

/** @param {{ onBackToLogin: () => void }} props */
const AdminDashboard = ({ onBackToLogin }) => {
  const [adminAccess, setAdminAccess] = useState('CHECKING');
  const [isRootDeveloper, setIsRootDeveloper] = useState(false);
  const [adminAccessError, setAdminAccessError] = useState('');
  const [adminVerificationAttempt, setAdminVerificationAttempt] = useState(0);

  // Student passwords are shown once after creation or reset and never persisted in the
  // browser. Purge copies stored by earlier versions of the portal.
  useEffect(() => {
    safeStorageRemove('localStorage', 'cbt_assigned_student_credentials');
  }, []);

  // sessionStorage controls only navigation. Every admin dashboard mount must
  // independently verify the authenticated Supabase role before rendering data.
  useEffect(() => {
    let active = true;
    const verifyAdmin = async () => {
      setAdminAccess('CHECKING');
      setAdminAccessError('');
      try {
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        if (!user) {
          if (active) {
            setAdminAccess('DENIED');
            onBackToLogin();
          }
          return;
        }

        const { data: role, error } = await supabase.rpc('get_my_role');
        if (error) throw error;
        if (!active) return;
        if (role !== 'admin') {
          setAdminAccess('DENIED');
          onBackToLogin();
          return;
        }

        const { data: allowed, error: accessError } = await supabase.rpc('is_admin_aal2');
        if (accessError) throw accessError;
        if (!active) return;
        if (allowed !== true) {
          setAdminAccess('DENIED');
          onBackToLogin();
          return;
        }

        const { data: root, error: rootError } = await supabase.rpc('is_root_developer');
        if (rootError) throw rootError;
        if (!active) return;
        setIsRootDeveloper(root === true);
        setAdminAccess('GRANTED');
      } catch (error) {
        console.error('Administrator verification failed:', error);
        if (active) {
          setAdminAccess('ERROR');
          setAdminAccessError('Administrator access could not be verified. Check the connection and retry.');
        }
      }
    };
    verifyAdmin();
    return () => { active = false; };
  }, [onBackToLogin, adminVerificationAttempt]);

  if (adminAccess !== 'GRANTED') {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 p-4">
        <Card className="w-full max-w-[520px]">
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <div className={cn('grid size-12 place-items-center rounded-full ring-1', adminAccess === 'CHECKING' ? 'bg-brand-50 text-brand-600 ring-brand-100' : 'bg-red-50 text-red-600 ring-red-100')}>
              {adminAccess === 'CHECKING'
                ? <Loader2 className="size-6 animate-spin" aria-hidden="true" />
                : <Lock className="size-6" aria-hidden="true" />}
            </div>
            <p role={adminAccess === 'ERROR' ? 'alert' : 'status'} className={cn('text-sm', adminAccess === 'CHECKING' ? 'text-slate-600' : 'font-medium text-red-700')}>
              {adminAccess === 'CHECKING' ? 'Verifying administrator access…' : adminAccessError || 'Access denied.'}
            </p>
            {adminAccess === 'ERROR' && (
              <Button onClick={() => setAdminVerificationAttempt(value => value + 1)}>
                <RotateCcw aria-hidden="true" /> Retry verification
              </Button>
            )}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <AdminProvider isRootDeveloper={isRootDeveloper}>
      <AdminWorkspace onBackToLogin={onBackToLogin} />
    </AdminProvider>
  );
};

export default AdminDashboard;
