import React, { useState, useEffect, useRef } from 'react';
import { showToast, customAlert, customConfirm, customPrompt } from '../utils';
import { supabase } from '../supabase';
import QuestionEditor from './QuestionEditor';
import ExamQuestionsArchive from './ExamQuestionsArchive';
import MathRenderer from './MathRenderer';
import ReviewedJsonImporter from './AIQuestionImporter';
import { prepareQuestionDraft } from '../questionContentLogic';
import StorageImage from './StorageImage';
import AdminOperationsView from './AdminOperationsView';
import AdminDatabaseCleanerView from './AdminDatabaseCleanerView';
import { fetchAllRows, parsePagedCollectionResponse } from '../paginatedQuery';
import { normalizeQuestionBankRow, parseSelectedQuestionsResponse } from '../questionBankPaging';
import { normalizeExamListRow } from '../examListPaging';
import { safeStorageRemove, safeStorageSet } from '../browserStorage';
import { createLatestRequestTracker, runWithDeadline } from '../adminDataReliability';
import {
  buildLeaderboardCsv,
  createLeaderboardPdfDocument,
  MAX_PDF_RESULT_ROWS,
  safeDownloadName,
  validatePdfExport
} from '../resultExportLogic';
import { parseResultExportPageResponse, parseResultPageResponse, validateCompleteResultExport } from '../resultPaging';

const AdminAnalyticsCharts = React.lazy(() => import('./AdminAnalyticsCharts'));
const STUDENT_ROSTER_PAGE_SIZE = 100;
const QUESTION_BANK_PAGE_SIZE = 50;
const MAX_EXAM_QUESTIONS = 500;
const EXAM_LIST_PAGE_SIZE = 24;
const RESULT_PAGE_SIZE = 100;
const RESULT_EXPORT_PAGE_SIZE = 500;

const AdminDashboard = ({ onBackToLogin }) => {
  const [adminAccess, setAdminAccess] = useState('CHECKING');
  const [adminAccessError, setAdminAccessError] = useState('');
  const [adminVerificationAttempt, setAdminVerificationAttempt] = useState(0);
  const [dataLoadState, setDataLoadState] = useState({});
  const [exams, setExams] = useState([]);
  const [activeExamDetail, setActiveExamDetail] = useState(null);
  const [examSearchInput, setExamSearchInput] = useState('');
  const [examSearch, setExamSearch] = useState('');
  const [examStatusFilter, setExamStatusFilter] = useState('');
  const [examListPage, setExamListPage] = useState(0);
  const [examListTotal, setExamListTotal] = useState(0);
  const [examListSnapshot, setExamListSnapshot] = useState({ page: 0, search: '', status: '' });
  const [studentResults, setStudentResults] = useState([]);
  const [resultSearchInput, setResultSearchInput] = useState('');
  const [resultSearch, setResultSearch] = useState('');
  const [resultPage, setResultPage] = useState(0);
  const [resultPageTotal, setResultPageTotal] = useState(0);
  const [resultOverallCount, setResultOverallCount] = useState(0);
  const [resultSubjects, setResultSubjects] = useState([]);
  const [resultAnalytics, setResultAnalytics] = useState(null);
  const [resultSnapshot, setResultSnapshot] = useState({ examId: null, page: 0, search: '' });
  const [studentsList, setStudentsList] = useState([]);
  const [questionBank, setQuestionBank] = useState([]);
  
  const [classes, setClasses] = useState([]);
  const [newClassName, setNewClassName] = useState('');
  const [newClassSections, setNewClassSections] = useState('');
  
  const [newStudentPassword, setNewStudentPassword] = useState('');
  const [isAddingStudent, setIsAddingStudent] = useState(false);
  const [selectedStudentClass, setSelectedStudentClass] = useState('');
  const [selectedStudentSection, setSelectedStudentSection] = useState('');

  const [examTargetClass, setExamTargetClass] = useState('');
  const [examTargetSection, setExamTargetSection] = useState('');

  const [selectedStudents, setSelectedStudents] = useState([]);
  const [studentFilterClass, setStudentFilterClass] = useState('');
  const [studentFilterSection, setStudentFilterSection] = useState('');
  const [studentSearchInput, setStudentSearchInput] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  const [studentRosterPage, setStudentRosterPage] = useState(0);
  const [studentRosterTotal, setStudentRosterTotal] = useState(0);
  const [studentRosterSnapshot, setStudentRosterSnapshot] = useState({ page: 0, search: '', className: '', section: '' });

  const pendingAdded = useRef([]);
  const pendingDeleted = useRef([]);
  const debounceTimer = useRef(null);
  const countRefreshTimer = useRef(null);
  const collectionRefreshTimers = useRef(new Map());
  const dataLoadTracker = useRef(createLatestRequestTracker());
  const loadedCollections = useRef(new Set());
  const activeExamIdRef = useRef(null);
  const studentsListRef = useRef([]);
  const studentRosterQueryRef = useRef({ page: 0, search: '', className: '', section: '' });
  const questionBankQueryRef = useRef({ page: 0, search: '', subject: '', type: '' });
  const examListQueryRef = useRef({ page: 0, search: '', status: '' });
  const resultQueryRef = useRef({ examId: null, page: 0, search: '' });
  const csvDownloadInFlight = useRef(false);
  const pdfDownloadInFlight = useRef(false);

  // Declared before the effects below because the resultQueryRef effect reads
  // `activeExamId` in its dependency array; a later `const` declaration would put
  // it in the temporal dead zone and throw on first render.
  const [activeTab, setActiveTab] = useState('DASHBOARD'); // 'DASHBOARD', 'STUDENTS', 'CLASSES', 'QUESTION_BANK'
  const [activeExamId, setActiveExamId] = useState(null);

  useEffect(() => {
    studentsListRef.current = studentsList;
  }, [studentsList]);

  useEffect(() => {
    studentRosterQueryRef.current = {
      page: studentRosterPage,
      search: studentSearch,
      className: studentFilterClass,
      section: studentFilterSection
    };
  }, [studentRosterPage, studentSearch, studentFilterClass, studentFilterSection]);

  useEffect(() => {
    examListQueryRef.current = { page: examListPage, search: examSearch, status: examStatusFilter };
  }, [examListPage, examSearch, examStatusFilter]);

  useEffect(() => {
    resultQueryRef.current = { examId: activeExamId, page: resultPage, search: resultSearch };
  }, [activeExamId, resultPage, resultSearch]);

  useEffect(() => {
    const tracker = dataLoadTracker.current;
    tracker.activate();
    return () => { tracker.deactivate(); };
  }, []);

  useEffect(() => {
    activeExamIdRef.current = activeExamId;
    setActiveExamDetail(null);
    setStudentResults([]);
    setResultSearchInput('');
    setResultSearch('');
    setResultPage(0);
    setResultPageTotal(0);
    setResultOverallCount(0);
    setResultSubjects([]);
    setResultAnalytics(null);
    resultQueryRef.current = { examId: activeExamId, page: 0, search: '' };
  }, [activeExamId]);
  
  
  // Question Bank states
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [selectedQuestions, setSelectedQuestions] = useState([]);
  const [questionSearchInput, setQuestionSearchInput] = useState('');
  const [questionSearch, setQuestionSearch] = useState('');
  const [questionSubjectInput, setQuestionSubjectInput] = useState('');
  const [questionSubjectFilter, setQuestionSubjectFilter] = useState('');
  const [questionTypeFilter, setQuestionTypeFilter] = useState('');
  const [questionBankPage, setQuestionBankPage] = useState(0);
  const [questionBankTotal, setQuestionBankTotal] = useState(0);
  const [questionBankSnapshot, setQuestionBankSnapshot] = useState({ page: 0, search: '', subject: '', type: '' });

  useEffect(() => {
    questionBankQueryRef.current = {
      page: questionBankPage,
      search: questionSearch,
      subject: questionSubjectFilter,
      type: questionTypeFilter
    };
  }, [questionBankPage, questionSearch, questionSubjectFilter, questionTypeFilter]);
  

  const [newExamTitle, setNewExamTitle] = useState('');
  const [isCreatingExam, setIsCreatingExam] = useState(false);
  const [examDuration, setExamDuration] = useState(180);
  const [examMarksCorrect, setExamMarksCorrect] = useState(4);
  const [examMarksIncorrect, setExamMarksIncorrect] = useState(-1);
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentId, setNewStudentId] = useState('');
  const [dbSize, setDbSize] = useState(null);
  const [operationalHealth, setOperationalHealth] = useState(null);
  const [auditEvents, setAuditEvents] = useState([]);
  const [operationalLoading, setOperationalLoading] = useState(false);
  const [operationalError, setOperationalError] = useState('');
  const [unreferencedAssets, setUnreferencedAssets] = useState(null);
  const [scanningAssets, setScanningAssets] = useState(false);
  const [cleaningAssets, setCleaningAssets] = useState(false);

  const handleScanUnreferencedAssets = async () => {
    setScanningAssets(true);
    try {
      const { data, error } = await supabase.rpc('get_unreferenced_exam_assets');
      if (error) throw error;
      setUnreferencedAssets(data || []);
      showToast(`Scan complete: ${data?.length || 0} unreferenced assets found.`, 'info');
    } catch (err) {
      console.error('Scan unreferenced assets failed:', err);
      await customAlert(`Scan failed: ${err.message}`);
    } finally {
      setScanningAssets(false);
    }
  };

  const handleCleanupUnreferencedAssets = async () => {
    if (!unreferencedAssets || unreferencedAssets.length === 0) return;
    const confirmed = await customConfirm(`Permanently delete ${unreferencedAssets.length} unreferenced storage files from "exam-assets"? This action cannot be undone.`);
    if (!confirmed) return;

    setCleaningAssets(true);
    try {
      const requestedPaths = unreferencedAssets.map(asset => asset.name).filter(Boolean);
      let deletedCount = 0;
      for (let offset = 0; offset < requestedPaths.length; offset += 100) {
        const batch = requestedPaths.slice(offset, offset + 100);
        // The Storage API removes both the object bytes and their metadata.
        // Its database DELETE policy re-checks references at deletion time.
        const { data: removed, error: removeError } = await supabase.storage.from('exam-assets').remove(batch);
        if (removeError) throw removeError;
        const removedPaths = (removed || []).map(asset => asset.name).filter(Boolean);
        if (removedPaths.length === 0 && batch.length > 0) {
          throw new Error('Storage did not confirm deletion of the selected files.');
        }
        const { error: auditError } = await supabase.rpc('record_exam_asset_cleanup', {
          asset_names: removedPaths
        });
        if (auditError) throw auditError;
        deletedCount += removedPaths.length;
      }
      await customAlert(`Cleanup successful: deleted ${deletedCount} unreferenced files through secure storage.`);
      await handleScanUnreferencedAssets();
      await fetchOperationalOverview();
    } catch (err) {
      console.error('Cleanup unreferenced assets failed:', err);
      await customAlert(`Cleanup failed: ${err.message}`);
    } finally {
      setCleaningAssets(false);
    }
  };

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

        // Mandatory MFA TOTP (AAL2) verification
        const { data: aalData, error: aalErr } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (aalErr) throw aalErr;
        if (!active) return;
        if (aalData?.currentLevel !== 'aal2') {
          setAdminAccess('DENIED');
          onBackToLogin();
          return;
        }

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

  const runAdminDataLoad = async (key, failureMessage, work) => {
    const generation = dataLoadTracker.current.begin(key);
    setDataLoadState(current => ({
      ...current,
      [key]: { loading: true, error: '' }
    }));
    try {
      const data = await runWithDeadline(work);
      const currentRequest = dataLoadTracker.current.isCurrent(key, generation);
      if (currentRequest) {
        setDataLoadState(current => ({
          ...current,
          [key]: { loading: false, error: '' }
        }));
      }
      return { ok: true, current: currentRequest, data };
    } catch (error) {
      console.error(`${key} loading failed:`, error);
      const currentRequest = dataLoadTracker.current.isCurrent(key, generation);
      if (currentRequest) {
        setDataLoadState(current => ({
          ...current,
          [key]: { loading: false, error: failureMessage }
        }));
      }
      return { ok: false, current: currentRequest, error };
    }
  };

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const [tableCounts, setTableCounts] = useState({
    question_bank: null,
    cbt_exams: null,
    student_results: null,
    active_sessions: null,
    students: null,
    classes: null,
    import_history: null
  });

  const fetchTableCounts = async () => {
    const result = await runAdminDataLoad('counts', 'Dashboard totals could not be refreshed. Existing figures may be stale.', async () => {
      const [q, e, r, s, st, c, h, size] = await Promise.all([
        supabase.from('question_bank').select('id', { count: 'exact', head: true }),
        supabase.from('cbt_exams').select('id', { count: 'exact', head: true }),
        supabase.from('student_results').select('id', { count: 'exact', head: true }),
        supabase.from('active_sessions').select('id', { count: 'exact', head: true }),
        supabase.from('students').select('id', { count: 'exact', head: true }),
        supabase.from('classes').select('id', { count: 'exact', head: true }),
        supabase.from('import_history').select('id', { count: 'exact', head: true }),
        supabase.rpc('get_db_size')
      ]);
      const failed = [q, e, r, s, st, c, h, size].find(result => result.error);
      if (failed?.error) throw failed.error;
      const sizeData = size.data;
      return {
        counts: {
          question_bank: q.count || 0,
          cbt_exams: e.count || 0,
          student_results: r.count || 0,
          active_sessions: s.count || 0,
          students: st.count || 0,
          classes: c.count || 0,
          import_history: h.count || 0
        },
        totalSize: sizeData
          ? sizeData.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0)
          : null
      };
    });
    if (result.ok && result.current) {
      setTableCounts(result.data.counts);
      if (result.data.totalSize !== null) setDbSize(result.data.totalSize);
    }
    return result.ok;
  };

  const scheduleTableCounts = () => {
    if (countRefreshTimer.current) clearTimeout(countRefreshTimer.current);
    countRefreshTimer.current = setTimeout(() => {
      countRefreshTimer.current = null;
      fetchTableCounts();
    }, 300);
  };

  const scheduleCollectionRefresh = (key, refresh) => {
    const existing = collectionRefreshTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      collectionRefreshTimers.current.delete(key);
      refresh();
    }, 300);
    collectionRefreshTimers.current.set(key, timer);
  };

  const fetchOperationalOverview = async () => {
    if (operationalLoading) return;
    setOperationalLoading(true);
    setOperationalError('');
    try {
      const [healthResult, auditResult] = await Promise.all([
        supabase.rpc('admin_operational_health'),
        supabase.from('admin_audit_events')
          .select('id, actor_user_id, action, target_type, target_id, metadata, occurred_at')
          .order('occurred_at', { ascending: false })
          .limit(100)
      ]);
      if (healthResult.error) throw healthResult.error;
      if (auditResult.error) throw auditResult.error;
      setOperationalHealth(healthResult.data);
      setAuditEvents(auditResult.data || []);
    } catch (error) {
      console.error('Operational overview failed:', error);
      setOperationalError('Operational status could not be loaded. Verify the database connection and your MFA session.');
    } finally {
      setOperationalLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'OPERATIONS' && adminAccess === 'GRANTED') fetchOperationalOverview();
  // Refresh is deliberately tied to entering the view; the button handles later refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, adminAccess]);

  // Helper to fetch all data from a table
  const fetchExams = async () => {
    const query = { ...examListQueryRef.current };
    const result = await runAdminDataLoad('exams', 'The examination list page could not be loaded. Existing entries may be stale.', async () => {
      const { data, error } = await supabase.rpc('get_admin_exam_list_page', {
        page_number_param: query.page,
        page_size_param: EXAM_LIST_PAGE_SIZE,
        search_param: query.search || null,
        status_param: query.status || null
      });
      if (error) throw error;
      return parsePagedCollectionResponse(data, { expectedPage: query.page, expectedPageSize: EXAM_LIST_PAGE_SIZE });
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setExams(data.rows.map(normalizeExamListRow));
    setExamListTotal(data.total);
    setExamListSnapshot(query);
    const lastPage = Math.max(0, Math.ceil(data.total / EXAM_LIST_PAGE_SIZE) - 1);
    if (data.page > lastPage) setExamListPage(lastPage);
    loadedCollections.current.add('exams');
    scheduleTableCounts();
    return true;
  };
  const fetchExamDetail = async (examId) => {
    const result = await runAdminDataLoad('examDetail', 'The selected examination details could not be loaded.', async () => {
      const { data, error } = await supabase.from('cbt_exams').select('*').eq('id', examId).single();
      if (error) throw error;
      return data;
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    if (activeExamIdRef.current === examId) setActiveExamDetail({ ...data, questionsData: data.questions_data });
    return true;
  };
  const fetchResults = async (examId = activeExamIdRef.current) => {
    if (!examId) {
      setStudentResults([]);
      return true;
    }
    const currentQuery = resultQueryRef.current;
    const query = currentQuery.examId === examId ? { ...currentQuery } : { examId, page: 0, search: '' };
    const result = await runAdminDataLoad('results', 'The leaderboard page could not be loaded. Existing results may be stale or incomplete.', async () => {
      const { data, error } = await supabase.rpc('get_admin_exam_results_page', {
        exam_id_param: examId,
        page_number_param: query.page,
        page_size_param: RESULT_PAGE_SIZE,
        search_param: query.search || null,
        expected_result_count_param: null
      });
      if (error) throw error;
      return parseResultPageResponse(data, { expectedPage: query.page, expectedPageSize: RESULT_PAGE_SIZE });
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setStudentResults(data.rows);
    setResultPageTotal(data.total);
    setResultOverallCount(data.resultCount);
    setResultSubjects(data.subjects);
    setResultAnalytics(data.analytics);
    setResultSnapshot(query);
    const lastPage = Math.max(0, Math.ceil(data.total / RESULT_PAGE_SIZE) - 1);
    if (data.page > lastPage) setResultPage(lastPage);
    loadedCollections.current.add('results');
    scheduleTableCounts();
    return true;
  };
  const fetchStudents = async () => {
    const query = { ...studentRosterQueryRef.current };
    const result = await runAdminDataLoad('students', 'The student roster page could not be loaded. Existing entries may be stale or incomplete.', async () => {
      const { data, error } = await supabase.rpc('get_admin_student_roster_page', {
        page_number_param: query.page,
        page_size_param: STUDENT_ROSTER_PAGE_SIZE,
        search_param: query.search || null,
        class_param: query.className || null,
        section_param: query.section || null
      });
      if (error) throw error;
      return parsePagedCollectionResponse(data, {
        expectedPage: query.page,
        expectedPageSize: STUDENT_ROSTER_PAGE_SIZE
      });
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setStudentsList(data.rows.map(s => ({ docId: s.id, id: s.student_id, name: s.name, ...s })));
    setStudentRosterTotal(data.total);
    setStudentRosterSnapshot(query);
    const lastPage = Math.max(0, Math.ceil(data.total / STUDENT_ROSTER_PAGE_SIZE) - 1);
    if (data.page > lastPage) setStudentRosterPage(lastPage);
    loadedCollections.current.add('students');
    scheduleTableCounts();
    return true;
  };
  const fetchQuestionBank = async () => {
    const query = { ...questionBankQueryRef.current };
    const result = await runAdminDataLoad('questions', 'The question bank page could not be loaded. Existing entries may be stale or incomplete.', async () => {
      const { data, error } = await supabase.rpc('get_admin_question_bank_page', {
        page_number_param: query.page,
        page_size_param: QUESTION_BANK_PAGE_SIZE,
        search_param: query.search || null,
        subject_param: query.subject || null,
        type_param: query.type || null
      });
      if (error) throw error;
      return parsePagedCollectionResponse(data, {
        expectedPage: query.page,
        expectedPageSize: QUESTION_BANK_PAGE_SIZE
      });
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setQuestionBank(data.rows.map(normalizeQuestionBankRow));
    setQuestionBankTotal(data.total);
    setQuestionBankSnapshot(query);
    const lastPage = Math.max(0, Math.ceil(data.total / QUESTION_BANK_PAGE_SIZE) - 1);
    if (data.page > lastPage) setQuestionBankPage(lastPage);
    loadedCollections.current.add('questions');
    scheduleTableCounts();
    return true;
  };
  const fetchClasses = async () => {
    const result = await runAdminDataLoad('classes', 'Classes and sections could not be loaded. Existing entries may be stale.', () => fetchAllRows((from, to) => supabase.from('classes').select('*')
      .order('name', { ascending: true }).order('id', { ascending: true }).range(from, to)));
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    setClasses(data || []);
    loadedCollections.current.add('classes');
    scheduleTableCounts();
    return true;
  };

  useEffect(() => {
    if (adminAccess !== 'GRANTED') return;
    if (activeExamId) {
      Promise.all([fetchResults(activeExamId), fetchExamDetail(activeExamId)]).catch(error => {
        console.error('Exam detail loading failed:', error);
        customAlert('The complete exam details could not be loaded. Please check the connection and try again.');
      });
      return;
    }
    if (activeTab === 'DASHBOARD') {
      fetchExams();
    } else if (activeTab === 'STUDENTS') {
      fetchStudents();
      if (!loadedCollections.current.has('classes')) fetchClasses();
    } else if (activeTab === 'CLASSES') {
      if (!loadedCollections.current.has('classes')) fetchClasses();
    } else if (activeTab === 'QUESTION_BANK' || activeTab === 'AI_IMPORTER') {
      // This effect owns the server-side Question Bank query as well as the
      // initial load. A load-once guard here suppresses every later filter and
      // page request, leaving the old page visible and its controls disabled.
      fetchQuestionBank();
      if (!loadedCollections.current.has('classes')) fetchClasses();
    }
  // Collection loaders intentionally run only when their owning screen opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAccess, activeTab, activeExamId, resultPage, resultSearch, examListPage, examSearch, examStatusFilter, studentRosterPage, studentSearch, studentFilterClass, studentFilterSection, questionBankPage, questionSearch, questionSubjectFilter, questionTypeFilter]);

  useEffect(() => {
    if (adminAccess !== 'GRANTED') return;
    const refreshTimers = collectionRefreshTimers.current;
    // The overview needs only exams and aggregate counts. Large collections
    // are loaded when their owning screen is opened.
    fetchTableCounts();

    // Supabase Realtime subscriptions
    const examsChannel = supabase
      .channel('admin-exams')
      // Raw papers never enter Realtime; this table contains metadata only.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_status_events' }, () => scheduleCollectionRefresh('exams', async () => {
        await fetchExams();
        const currentExamId = activeExamIdRef.current;
        if (currentExamId) await fetchExamDetail(currentExamId);
      }))
      .subscribe();

    const resultsChannel = supabase
      .channel('admin-results')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'student_results' }, (payload) => {
        const currentExamId = activeExamIdRef.current;
        const result = payload.new || payload.old;
        if (currentExamId && result?.exam_id === currentExamId) {
          scheduleCollectionRefresh('results', () => fetchResults(currentExamId));
        } else {
          scheduleTableCounts();
        }
      })
      .subscribe();

    const studentsChannel = supabase
      .channel('admin-students')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, (payload) => {
        // Fetch fresh list
        if (loadedCollections.current.has('students')) {
          scheduleCollectionRefresh('students', fetchStudents);
        } else {
          scheduleTableCounts();
        }

        // Accumulate details for notifications
        if (payload.eventType === 'INSERT') {
          pendingAdded.current.push(payload.new.name || payload.new.student_id);
        } else if (payload.eventType === 'DELETE') {
          const matched = studentsListRef.current.find(s => s.docId === payload.old.id);
          const oldName = matched ? matched.name : (payload.old.student_id || `ID: ${payload.old.id}`);
          pendingDeleted.current.push(oldName);
        }

        // Debounce browser popup alert
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
          const added = [...pendingAdded.current];
          const deleted = [...pendingDeleted.current];
          pendingAdded.current = [];
          pendingDeleted.current = [];

          if (added.length > 0) {
            if (added.length === 1) {
              showToast(`Student "${added[0]}" added successfully.`, "success");
            } else {
              showToast(`${added.length} students added successfully.`, "success");
            }
          }

          if (deleted.length > 0) {
            if (deleted.length === 1) {
              showToast(`Student "${deleted[0]}" deleted successfully.`, "success");
            } else {
              showToast(`${deleted.length} students deleted successfully.`, "success");
            }
          }
        }, 500);
      })
      .subscribe();

    const qbChannel = supabase
      .channel('admin-qb')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'question_bank' }, () => {
        if (loadedCollections.current.has('questions')) scheduleCollectionRefresh('questions', fetchQuestionBank);
        else scheduleTableCounts();
      })
      .subscribe();

    const classesChannel = supabase
      .channel('admin-classes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, () => {
        if (loadedCollections.current.has('classes')) scheduleCollectionRefresh('classes', fetchClasses);
        else scheduleTableCounts();
      })
      .subscribe();

    return () => {
      if (countRefreshTimer.current) clearTimeout(countRefreshTimer.current);
      refreshTimers.forEach(timer => clearTimeout(timer));
      refreshTimers.clear();
      supabase.removeChannel(examsChannel);
      supabase.removeChannel(resultsChannel);
      supabase.removeChannel(studentsChannel);
      supabase.removeChannel(qbChannel);
      supabase.removeChannel(classesChannel);
    };
  // The subscriptions are intentionally recreated only when authorization
  // changes. Their callbacks read the current query state from refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAccess]);





  const handleSaveQuestion = async (editedQ) => {
    const { question: normalizedQuestion, errors } = prepareQuestionDraft(editedQ, questionBank);
    if (errors.length > 0) {
      await customAlert(errors.join('\n'));
      return false;
    }

    try {
      const questionData = {
        subject: normalizedQuestion.subject,
        type: normalizedQuestion.type,
        question_text: normalizedQuestion.text,
        options: normalizedQuestion.options,
        correct_answer: normalizedQuestion.correctAnswer,
        question_image_url: normalizedQuestion.questionImageUrl,
        option_image_urls: normalizedQuestion.optionImageUrls,
        has_image_or_diagram: normalizedQuestion.hasImageOrDiagram,
      };

      if (normalizedQuestion.docId === 'new') {
        const { error } = await supabase.from('question_bank').insert(questionData);
        if (error) throw error;
        showToast("Question created successfully and added to the Question Bank!", "success");
      } else {
        const { error } = await supabase.from('question_bank').update(questionData).eq('id', normalizedQuestion.docId);
        if (error) throw error;
        showToast("Question updated successfully!", "success");
      }
      setEditingQuestion(null);
      return true;
    } catch (err) {
      console.error("Error saving question:", err);
      await customAlert(`Failed to save question: ${err.message}`);
      return false;
    }
  };

  const handleDeleteQuestion = async (docId) => {
    if (await customConfirm("Delete this question from the bank?")) {
      const { error } = await supabase.rpc('admin_delete_question', { question_id_param: docId });
      if (error) {
        await customAlert(`Question deletion failed: ${error.message}`);
        return;
      }
      showToast("Question deleted successfully.", "success");
    }
  };

  const handleDeleteAllQuestions = async () => {
    if (!await customConfirm('Clear every question from the reusable Question Bank? Existing exam papers remain unchanged.')) return;
    const confirmation = await customPrompt("Type 'CLEAR QUESTION BANK' to continue:");
    if (confirmation !== 'CLEAR QUESTION BANK') {
      await customAlert('Question-bank cleanup cancelled.');
      return;
    }
    const { error } = await supabase.rpc('admin_clear_question_bank', { confirmation_param: confirmation });
    if (error) {
      await customAlert(`Question bank cleanup failed: ${error.message}`);
      return;
    }
    setSelectedQuestions([]);
    showToast('Question bank cleared successfully. Exam snapshots and image assets were retained.', 'success');
    await fetchQuestionBank();
  };

  const handleAddBlankQuestion = (qType = 'MCQ') => {
    const isNumerical = qType === 'NUMERICAL';
    setEditingQuestion({
      docId: 'new',
      subject: 'Physics',
      type: isNumerical ? 'NUMERICAL' : 'MCQ',
      text: '',
      options: isNumerical ? [] : ['', '', '', ''],
      correctAnswer: isNumerical ? '' : 0,
      questionImageUrl: null,
      optionImageUrls: [null, null, null, null]
    });
  };

  const handleCreateExamFromSelected = async () => {
    if (isCreatingExam) return;
    if (selectedQuestions.length === 0) {
      await customAlert("Please select at least one question.");
      return;
    }
    if (selectedQuestions.length > MAX_EXAM_QUESTIONS) {
      await customAlert(`An exam can contain at most ${MAX_EXAM_QUESTIONS} questions. Remove ${selectedQuestions.length - MAX_EXAM_QUESTIONS} question(s) and try again.`);
      return;
    }
    if (!newExamTitle.trim()) {
      await customAlert("Please enter an Exam Title first.");
      return;
    }
    if (!examTargetClass || !examTargetSection) {
      await customAlert("Please select a target Class and Section for the exam.");
      return;
    }

    setIsCreatingExam(true);
    let selectedQData;
    try {
      const requestedIds = [...selectedQuestions];
      const { data, error } = await supabase.rpc('get_admin_questions_by_ids', { question_ids_param: requestedIds });
      if (error) throw error;
      selectedQData = parseSelectedQuestionsResponse(data, requestedIds);
    } catch (error) {
      console.error('Selected questions could not be verified:', error);
      await customAlert(`The selected questions could not be verified: ${error.message}`);
      setIsCreatingExam(false);
      return;
    }
    const invalidSelectedQuestions = selectedQData
      .map((question, index) => ({ number: index + 1, errors: prepareQuestionDraft(question, selectedQData).errors }))
      .filter(result => result.errors.length > 0);
    if (invalidSelectedQuestions.length > 0) {
      const summary = invalidSelectedQuestions.slice(0, 5)
        .map(result => `Question ${result.number}: ${result.errors.join(' ')}`)
        .join('\n');
      await customAlert(`The exam cannot be created until the selected questions are complete:\n\n${summary}`);
      setIsCreatingExam(false);
      return;
    }
    
    const subjects = [...new Set(selectedQData.map(q => q.subject))];
    const questionsObj = {};
    subjects.forEach(sub => {
      questionsObj[sub] = selectedQData.filter(q => q.subject === sub);
    });

    const newExam = {
      title: newExamTitle,
      status: 'PENDING',
      questions_data: {
        subjects,
        questions: questionsObj,
        totalQuestions: selectedQData.length,
        duration: examDuration,
        marksCorrect: examMarksCorrect,
        marksIncorrect: examMarksIncorrect
      },
      class: examTargetClass,
      section: examTargetSection
    };

    try {
      const { error } = await supabase.from('cbt_exams').insert({ ...newExam, title: newExamTitle.trim() });
      if (error) throw error;
      setNewExamTitle('');
      setSelectedQuestions([]);
      setExamTargetClass('');
      setExamTargetSection('');
      setExamDuration(180);
      setExamMarksCorrect(4);
      setExamMarksIncorrect(-1);
      setExamSearchInput('');
      setExamSearch('');
      setExamStatusFilter('');
      setExamListPage(0);
      setActiveTab('DASHBOARD');
      showToast("Exam created successfully!", "success");
    } catch (error) {
      console.error('Exam creation failed:', error);
      await customAlert(`The exam was not created: ${error.message}`);
    } finally {
      setIsCreatingExam(false);
    }
  };

  const handlePreflightCheck = async (examId) => {
    try {
      const { data, error } = await supabase.rpc('preflight_validate_exam', { exam_id_param: examId });
      if (error) throw error;
      if (data.valid) {
        await customAlert(`✓ Preflight Check Passed!\n\nTotal Questions: ${data.totalQuestions}\nVerified Storage Assets: ${data.verifiedAssets}\nWarnings: ${data.warnings?.length || 0}`);
        return true;
      } else {
        const errorList = (data.errors || []).slice(0, 8).join('\n• ');
        await customAlert(`⚠️ Preflight Check Failed (${data.errors?.length || 0} errors):\n\n• ${errorList}\n\nResolve these issues before activating the exam.`);
        return false;
      }
    } catch (err) {
      console.error('Preflight check RPC error:', err);
      await customAlert(`Preflight check failed: ${err.message}`);
      return false;
    }
  };

  const toggleExamStatus = async (examId) => {
    const exam = activeExamDetail?.id === examId ? activeExamDetail : exams.find(e => e.id === examId);
    if (!exam) return;
    const nextStatus = exam.status === 'ACTIVE' ? 'ENDED' : 'ACTIVE';
    if (nextStatus === 'ENDED') {
      const confirmed = await customConfirm(`Are you sure you want to END the exam "${exam.title}"? Students will no longer be able to start new attempts.`);
      if (!confirmed) return;
    } else if (nextStatus === 'ACTIVE') {
      if (exam.status === 'ENDED') {
        const hasResults = studentResults.some(r => (r.examId || r.exam_id) === examId);
        if (hasResults) {
          await customAlert("Cannot reactivate an ENDED exam that already has student submissions or active attempts.");
          return;
        }
      }
      const preflightPassed = await handlePreflightCheck(examId);
      if (!preflightPassed) return;
    }
    const { error } = await supabase.from('cbt_exams').update({
      status: nextStatus
    }).eq('id', examId);
    if (error) {
      console.error('Exam status update failed:', error);
      await customAlert(`The exam status was not changed: ${error.message}`);
      return;
    }
    showToast(`Exam ${nextStatus === 'ACTIVE' ? 'started' : 'ended'} successfully.`, 'success');
    await Promise.all([fetchExams(), activeExamId === examId ? fetchExamDetail(examId) : Promise.resolve(true)]);
  };
  
  const handleDeleteExam = async (examId) => {
    const exam = activeExamDetail?.id === examId ? activeExamDetail : exams.find(e => e.id === examId);
    if (!exam) return;
    if (exam.status === 'ACTIVE') {
      await customAlert("Cannot delete an ACTIVE exam. Please end the exam before attempting deletion.");
      return;
    }
    const confirmation = await customPrompt(`Type the exact exam title to delete this unused exam:\n\n${exam.title}`);
    if (confirmation === null) return;
    if (confirmation !== exam.title) {
      await customAlert('Exam deletion cancelled because the title did not match exactly.');
      return;
    }
    if (await customConfirm(`Permanently delete the unused exam "${exam.title}"?`)) {
      try {
        const { error: examError } = await supabase.rpc('admin_delete_unused_exam', {
          exam_id_param: examId,
          expected_title_param: confirmation
        });
        if (examError) throw examError;

        if (activeExamId === examId) {
          setActiveExamId(null);
          setActiveExamDetail(null);
        }
        showToast("Exam deleted successfully.", "success");
        await fetchExams();
      } catch (err) {
        console.error("Failed to delete exam:", err);
        await customAlert("Failed to delete exam: " + err.message);
      }
    }
  };

  const handleClassChange = (className) => {
    setSelectedStudentClass(className);
    const cls = classes.find(c => c.name === className);
    if (cls && cls.sections && cls.sections.length > 0) {
      setSelectedStudentSection(cls.sections[0]);
    } else {
      setSelectedStudentSection('');
    }
  };

  const handleAddStudent = async () => {
    if (isAddingStudent) return;
    if (!newStudentName.trim() || !newStudentId.trim() || !newStudentPassword || !selectedStudentClass || !selectedStudentSection) {
      await customAlert("Please fill in all student details: Name, ID, Password, Class, and Section.");
      return;
    }

    if (newStudentPassword.length < 12) {
      await customAlert("Student password must contain at least 12 characters.");
      return;
    }

    const trimmedId = newStudentId.trim();
    const trimmedName = newStudentName.trim();

    // Check against real-time local list (case-insensitive)
    const isDuplicate = studentsList.some(
      s => s.id && s.id.trim().toLowerCase() === trimmedId.toLowerCase()
    );

    if (isDuplicate) {
      await customAlert(`A student with ID "${trimmedId}" already exists!`);
      return;
    }

    // Double check directly with Supabase
    setIsAddingStudent(true);
    try {
      const { data: existing, error: duplicateCheckError } = await supabase
        .from('students')
        .select('id')
        .eq('student_id', trimmedId);
      if (duplicateCheckError) throw duplicateCheckError;
      if (existing && existing.length > 0) {
        await customAlert(`A student with ID "${trimmedId}" already exists in the database!`);
        return;
      }

      const { error: createError } = await supabase.functions.invoke('manage-student', {
        body: {
          action: 'create',
          studentId: trimmedId,
          name: trimmedName,
          password: newStudentPassword,
          className: selectedStudentClass,
          section: selectedStudentSection
        }
      });
      if (createError) throw createError;

      setNewStudentName('');
      setNewStudentId('');
      setNewStudentPassword('');
      setSelectedStudentClass('');
      setSelectedStudentSection('');
      showToast(`Student "${trimmedName}" added successfully.`, "success");
    } catch (err) {
      console.error("Error adding student:", err);
      await customAlert("Failed to add student: " + err.message);
    } finally {
      setIsAddingStudent(false);
    }
  };

  const handleDeactivateStudents = async (studentIds) => {
    const activeIds = studentIds.filter(id => !studentsList.find(student => student.docId === id)?.archived_at);
    if (activeIds.length === 0) return;
    const reason = await customPrompt('Enter the reason for deactivating the selected student account(s):');
    if (reason === null) return;
    if (reason.trim().length < 3 || reason.trim().length > 500) {
      await customAlert('A deactivation reason between 3 and 500 characters is required.');
      return;
    }
    if (!await customConfirm(`Deactivate ${activeIds.length} student account(s)? Their examination results will be retained.`)) return;
    try {
      const { error } = await supabase.rpc('admin_deactivate_students', {
        user_ids_param: activeIds,
        reason_param: reason
      });
      if (error) throw error;
      setSelectedStudents([]);
      showToast(`${activeIds.length} student account(s) deactivated.`, 'success');
      await fetchStudents();
    } catch (err) {
      console.error('Error deactivating students:', err);
      await customAlert(`Student deactivation failed: ${err.message}`);
    }
  };

  const handleReactivateStudent = async (docId) => {
    if (!await customConfirm('Reactivate this student account?')) return;
    try {
      const { error } = await supabase.rpc('admin_reactivate_students', { user_ids_param: [docId] });
      if (error) throw error;
      showToast('Student account reactivated.', 'success');
      await fetchStudents();
    } catch (err) {
      console.error('Error reactivating student:', err);
      await customAlert(`Student reactivation failed: ${err.message}`);
    }
  };

  const handleCreateClass = async () => {
    if (!newClassName.trim() || !newClassSections.trim()) {
      await customAlert("Please enter a class name and sections first.");
      return;
    }
    const sectionsArray = newClassSections
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length > 0);

    if (sectionsArray.length === 0) {
      await customAlert("Please enter at least one valid section.");
      return;
    }

    try {
      const { error } = await supabase.from('classes').insert({
        name: newClassName.trim(),
        sections: sectionsArray
      });
      if (error) throw error;
      setNewClassName('');
      setNewClassSections('');
      await customAlert("Class created successfully!");
    } catch (err) {
      console.error(err);
      await customAlert("Failed to create class: " + err.message);
    }
  };

  const handleClearTable = async (tableName, tableDisplayName) => {
    if (['student_results', 'cbt_exams', 'students', 'classes', 'import_history'].includes(tableName)) {
      const protectedMessages = {
        student_results: 'Submitted examination results are protected academic records and cannot be cleared.',
        cbt_exams: 'Bulk exam deletion is disabled. Delete an unused exam individually from Exam Management.',
        students: 'Bulk roster deletion is disabled. Student accounts can be deactivated from Student Management.',
        classes: 'Bulk class deletion is disabled. Empty classes can be deleted individually from Class Management.',
        import_history: 'Import history is retained as an operational audit record and cannot be cleared.'
      };
      await customAlert(protectedMessages[tableName]);
      return;
    }
    if (tableName === 'question_bank') {
      await handleDeleteAllQuestions();
      return;
    }
    if (tableName === 'active_sessions') {
      if (!await customConfirm('Finalize all expired attempts from their last server-confirmed answers? Unexpired attempts will remain untouched.')) return;
      try {
        const { data, error } = await supabase.rpc('admin_finalize_expired_sessions', { batch_limit_param: 100 });
        if (error) throw error;
        showToast(`${data?.finalized || 0} expired attempt(s) finalized safely.`, 'success');
        await Promise.all([fetchTableCounts(), fetchResults()]);
      } catch (err) {
        console.error('Expired-attempt finalization failed:', err);
        await customAlert(`Expired-attempt finalization failed: ${err.message}`);
      }
      return;
    }
    await customAlert(`No cleanup operation is available for ${tableDisplayName}.`);
  };



  const handleDeleteClass = async (classId) => {
    const classRecord = classes.find(item => item.id === classId);
    if (!classRecord) return;
    const confirmation = await customPrompt(`Type the exact class name to delete it:\n\n${classRecord.name}`);
    if (confirmation === null) return;
    if (confirmation !== classRecord.name) {
      await customAlert('Class deletion cancelled because the name did not match exactly.');
      return;
    }
    if (!await customConfirm(`Permanently delete the empty class "${classRecord.name}"?`)) return;
    try {
      const { error } = await supabase.rpc('admin_delete_empty_class', {
        class_id_param: classId,
        expected_name_param: confirmation
      });
      if (error) throw error;
      showToast('Empty class deleted successfully.', 'success');
      await fetchClasses();
    } catch (err) {
      console.error(err);
      await customAlert(`Failed to delete class: ${err.message}`);
    }
  };

  const renderClassesView = () => (
    <div className="animate-fade-in" style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '1px solid var(--border-color)' }}>
      <h2 style={{ marginBottom: '20px', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span>🏫</span> Class Management
      </h2>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '30px', flexWrap: 'wrap' }}>
        <input 
          type="text" 
          placeholder="Class Name (e.g. Class 10)" 
          value={newClassName} 
          onChange={e => setNewClassName(e.target.value)} 
          onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleCreateClass(); } }}
          style={{ flex: 1, minWidth: '200px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)' }} 
        />
        <input 
          type="text" 
          placeholder="Sections (comma-separated, e.g. A, B, C)" 
          value={newClassSections} 
          onChange={e => setNewClassSections(e.target.value)} 
          onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleCreateClass(); } }}
          style={{ flex: 1, minWidth: '200px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)' }} 
        />
        <button className="btn-primary" onClick={handleCreateClass} style={{ padding: '0 24px' }}>Create Class</button>
      </div>

      <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '2px solid var(--border-color)', color: 'var(--text-muted)' }}>
              <th style={{ padding: '16px' }}>Class Name</th>
              <th style={{ padding: '16px' }}>Sections</th>
              <th style={{ padding: '16px', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {classes.length === 0 ? (
              <tr><td colSpan="3" style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>No classes found. Create one above!</td></tr>
            ) : classes.map(cls => (
              <tr key={cls.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                <td style={{ padding: '16px', fontWeight: 'bold' }}>{cls.name}</td>
                <td style={{ padding: '16px' }}>
                  {(cls.sections || []).map(sec => (
                    <span key={sec} style={{ marginRight: '6px', backgroundColor: 'rgba(37,99,235,0.1)', color: 'var(--primary)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 'bold' }}>
                      {sec}
                    </span>
                  ))}
                </td>
                <td style={{ padding: '16px', textAlign: 'right' }}>
                  <button onClick={() => handleDeleteClass(cls.id)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '5px' }}>🗑️ Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderStudentsView = () => {
    const filteredStudents = studentsList;
    const selectableStudents = filteredStudents.filter(student => !student.archived_at);
    const totalPages = Math.max(1, Math.ceil(studentRosterTotal / STUDENT_ROSTER_PAGE_SIZE));
    const confirmedFirstRow = studentRosterTotal === 0 ? 0 : (studentRosterSnapshot.page * STUDENT_ROSTER_PAGE_SIZE) + 1;
    const confirmedLastRow = studentRosterTotal === 0
      ? 0
      : Math.min(studentRosterTotal, confirmedFirstRow + filteredStudents.length - 1);
    const rosterQueryChanged = studentRosterSnapshot.page !== studentRosterPage
      || studentRosterSnapshot.search !== studentSearch
      || studentRosterSnapshot.className !== studentFilterClass
      || studentRosterSnapshot.section !== studentFilterSection;
    const rosterState = dataLoadState.students || {};
    const rosterActionsDisabled = rosterQueryChanged || Boolean(rosterState.loading || rosterState.error);

    const applyStudentSearch = () => {
      const nextSearch = studentSearchInput.trim();
      setSelectedStudents([]);
      setStudentRosterPage(0);
      if (nextSearch === studentSearch && studentRosterPage === 0) fetchStudents();
      else setStudentSearch(nextSearch);
    };

    return (
      <div className="animate-fade-in" style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '1px solid var(--border-color)' }}>
        <h2 style={{ marginBottom: '20px', color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '10px' }}><span>👥</span> Student Roster</h2>
        
        {/* Add Student Form */}
        <div style={{ display: 'flex', gap: '10px', marginBottom: '30px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="text" placeholder="Student Name" value={newStudentName} onChange={e => setNewStudentName(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleAddStudent(); } }} style={{ flex: 1, minWidth: '150px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)' }} />
          <input type="text" placeholder="Student ID (Login ID)" value={newStudentId} onChange={e => setNewStudentId(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleAddStudent(); } }} style={{ flex: 1, minWidth: '150px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)' }} />
          <input type="password" autoComplete="new-password" aria-label="Initial student password" placeholder="Password (12+ characters)" value={newStudentPassword} onChange={e => setNewStudentPassword(e.target.value)} onKeyDown={async (e) => { if (e.key === 'Enter') { e.preventDefault(); await handleAddStudent(); } }} style={{ flex: 1, minWidth: '150px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)' }} />
          
          <select 
            value={selectedStudentClass} 
            onChange={e => handleClassChange(e.target.value)} 
            style={{ flex: 1, minWidth: '150px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'white' }}
          >
            <option value="">Select Class...</option>
            {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>

          <select 
            value={selectedStudentSection} 
            disabled={!selectedStudentClass} 
            onChange={e => setSelectedStudentSection(e.target.value)} 
            style={{ flex: 1, minWidth: '150px', padding: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'white' }}
          >
            <option value="">Select Section...</option>
            {selectedStudentClass && 
              (classes.find(c => c.name === selectedStudentClass)?.sections || []).map(sec => (
                <option key={sec} value={sec}>{sec}</option>
              ))
            }
          </select>

          <button className="btn-primary" onClick={handleAddStudent} disabled={isAddingStudent} style={{ padding: '12px 24px' }}>{isAddingStudent ? 'Adding…' : 'Add Student'}</button>
        </div>

        {/* Filter Controls & Bulk Action Bar */}
        <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', alignItems: 'center', backgroundColor: '#f8fafc', padding: '15px', borderRadius: '8px', border: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 'bold', fontSize: '0.9rem', color: 'var(--text-main)' }}>🔍 Filter Roster:</span>

          <input
            type="search"
            aria-label="Search students by name or student ID"
            placeholder="Name or student ID"
            maxLength={100}
            value={studentSearchInput}
            onChange={event => setStudentSearchInput(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyStudentSearch(); } }}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', minWidth: '190px' }}
          />
          <button type="button" onClick={applyStudentSearch} className="btn-outline" style={{ padding: '8px 12px' }}>Search</button>
          {(studentSearch || studentSearchInput) && (
            <button type="button" onClick={() => {
              setStudentSearchInput('');
              setStudentSearch('');
              setStudentRosterPage(0);
              setSelectedStudents([]);
            }} className="btn-outline" style={{ padding: '8px 12px' }}>Clear search</button>
          )}
          
          <select 
            value={studentFilterClass}
            aria-label="Filter roster by class"
            onChange={e => {
              setStudentFilterClass(e.target.value);
              setStudentFilterSection('');
              setStudentRosterPage(0);
              setSelectedStudents([]);
            }}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'white', minWidth: '150px' }}
          >
            <option value="">All Classes</option>
            {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>

          <select 
            value={studentFilterSection}
            aria-label="Filter roster by section"
            disabled={!studentFilterClass}
            onChange={e => {
              setStudentFilterSection(e.target.value);
              setStudentRosterPage(0);
              setSelectedStudents([]);
            }}
            style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', backgroundColor: 'white', minWidth: '150px' }}
          >
            <option value="">All Sections</option>
            {studentFilterClass && 
              (classes.find(c => c.name === studentFilterClass)?.sections || []).map(sec => (
                <option key={sec} value={sec}>{sec}</option>
              ))
            }
          </select>

          {selectedStudents.length > 0 ? (
            <button 
              className="btn-danger" 
              onClick={() => handleDeactivateStudents(selectedStudents)}
              style={{ marginLeft: 'auto', padding: '8px 16px', fontSize: '0.9rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: 'var(--danger)', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
            >
              ⛔ Deactivate Selected ({selectedStudents.length})
            </button>
          ) : null}
        </div>

        <div role="status" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '10px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          <span>Showing confirmed rows {confirmedFirstRow}-{confirmedLastRow} of {studentRosterTotal.toLocaleString()}.</span>
          {(rosterState.loading || rosterQueryChanged) && <span>Loading requested roster page…</span>}
        </div>
        {rosterQueryChanged && rosterState.error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>The table below is the last confirmed page. Row actions are disabled until the requested page loads.</p>
        )}

        {/* Student Table */}
        <fieldset disabled={rosterActionsDisabled} aria-busy={rosterState.loading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '2px solid var(--border-color)', color: 'var(--text-muted)' }}>
                <th style={{ padding: '16px', width: '50px', textAlign: 'center' }}>
                  <input 
                    type="checkbox"
                    aria-label="Select all active students on this page"
                    checked={selectableStudents.length > 0 && selectedStudents.length === selectableStudents.length}
                    disabled={selectableStudents.length === 0}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedStudents(selectableStudents.map(s => s.docId));
                      } else {
                        setSelectedStudents([]);
                      }
                    }}
                    style={{ cursor: 'pointer', width: '16px', height: '16px' }}
                  />
                </th>
                <th style={{ padding: '16px' }}>Student Name</th>
                <th style={{ padding: '16px' }}>Student ID (Username)</th>
                <th style={{ padding: '16px' }}>Class</th>
                <th style={{ padding: '16px' }}>Section</th>
                <th style={{ padding: '16px' }}>Status</th>
                <th style={{ padding: '16px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredStudents.length === 0 ? (
                <tr><td colSpan="7" style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>No students match the current filters.</td></tr>
              ) : filteredStudents.map(student => (
                <tr key={student.docId} style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: selectedStudents.includes(student.docId) ? 'rgba(239, 68, 68, 0.02)' : 'transparent' }}>
                  <td style={{ padding: '16px', textAlign: 'center', width: '50px' }}>
                    <input 
                      type="checkbox"
                      aria-label={`Select ${student.name} on this page`}
                      disabled={Boolean(student.archived_at)}
                      checked={selectedStudents.includes(student.docId)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedStudents([...selectedStudents, student.docId]);
                        } else {
                          setSelectedStudents(selectedStudents.filter(id => id !== student.docId));
                        }
                      }}
                      style={{ cursor: student.archived_at ? 'not-allowed' : 'pointer', width: '16px', height: '16px' }}
                    />
                  </td>
                  <td style={{ padding: '16px', fontWeight: 'bold' }}>{student.name}</td>
                  <td style={{ padding: '16px', fontFamily: 'monospace' }}>{student.id}</td>
                  <td style={{ padding: '16px' }}>
                    <select
                      value={student.class || ''}
                      disabled={Boolean(student.archived_at)}
                      onChange={async (e) => {
                        const newClass = e.target.value;
                        const matchedClass = classes.find(c => c.name === newClass);
                        const defaultSection = matchedClass && matchedClass.sections && matchedClass.sections.length > 0 ? matchedClass.sections[0] : '';
                        try {
                          if (!newClass || !defaultSection) throw new Error('Select a class with a valid section.');
                          const { error } = await supabase.functions.invoke('manage-student', {
                            body: {
                              action: 'update-assignment',
                              studentUserId: student.docId,
                              className: newClass,
                              section: defaultSection,
                            }
                          });
                          if (error) throw error;
                          showToast("Student class updated.", "success");
                        } catch (err) {
                          console.error(err);
                          await customAlert("Failed to update student class.");
                        }
                      }}
                      style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'white', fontSize: '0.9rem' }}
                    >
                      <option value="">N/A</option>
                      {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '16px' }}>
                    <select
                      value={student.section || ''}
                      disabled={!student.class || Boolean(student.archived_at)}
                      onChange={async (e) => {
                        const newSection = e.target.value;
                        try {
                          if (!newSection) throw new Error('Select a valid section.');
                          const { error } = await supabase.functions.invoke('manage-student', {
                            body: {
                              action: 'update-assignment',
                              studentUserId: student.docId,
                              className: student.class,
                              section: newSection,
                            }
                          });
                          if (error) throw error;
                          showToast("Student section updated.", "success");
                        } catch (err) {
                          console.error(err);
                          await customAlert("Failed to update student section.");
                        }
                      }}
                      style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color)', backgroundColor: 'white', fontSize: '0.9rem', fontWeight: student.section ? 'bold' : 'normal', color: student.section ? 'var(--primary)' : 'inherit' }}
                    >
                      <option value="">N/A</option>
                      {student.class && 
                        (classes.find(c => c.name === student.class)?.sections || []).map(sec => (
                          <option key={sec} value={sec}>{sec}</option>
                        ))
                      }
                    </select>
                  </td>
                  <td style={{ padding: '16px' }}>
                    <span title={student.archived_at ? student.archive_reason || 'Inactive' : 'Active'} style={{ padding: '4px 9px', borderRadius: '12px', fontSize: '0.78rem', fontWeight: 'bold', backgroundColor: student.archived_at ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', color: student.archived_at ? 'var(--danger)' : 'var(--success)' }}>
                      {student.archived_at ? 'INACTIVE' : 'ACTIVE'}
                    </span>
                  </td>
                  <td style={{ padding: '16px', textAlign: 'right' }}>
                    {student.archived_at ? (
                      <button onClick={() => handleReactivateStudent(student.docId)} style={{ background: 'none', border: 'none', color: 'var(--success)', cursor: 'pointer', padding: '5px' }}>↩ Reactivate</button>
                    ) : (
                      <button onClick={() => handleDeactivateStudents([student.docId])} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '5px' }}>⛔ Deactivate</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </fieldset>
        <nav aria-label="Student roster pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '18px' }}>
          <button type="button" className="btn-outline" disabled={studentRosterPage <= 0 || rosterActionsDisabled} onClick={() => {
            setSelectedStudents([]);
            setStudentRosterPage(page => Math.max(0, page - 1));
          }}>Previous</button>
          <span>Page {studentRosterPage + 1} of {totalPages}</span>
          <button type="button" className="btn-outline" disabled={studentRosterPage + 1 >= totalPages || rosterActionsDisabled} onClick={() => {
            setSelectedStudents([]);
            setStudentRosterPage(page => Math.min(totalPages - 1, page + 1));
          }}>Next</button>
        </nav>
      </div>
    );
  };

  const renderMasterView = () => {
    const totalPages = Math.max(1, Math.ceil(examListTotal / EXAM_LIST_PAGE_SIZE));
    const confirmedFirstRow = examListTotal === 0 ? 0 : (examListSnapshot.page * EXAM_LIST_PAGE_SIZE) + 1;
    const confirmedLastRow = examListTotal === 0 ? 0 : Math.min(examListTotal, confirmedFirstRow + exams.length - 1);
    const queryChanged = examListSnapshot.page !== examListPage
      || examListSnapshot.search !== examSearch
      || examListSnapshot.status !== examStatusFilter;
    const listState = dataLoadState.exams || {};
    const rowActionsDisabled = queryChanged || Boolean(listState.loading || listState.error);
    const applySearch = () => {
      const nextSearch = examSearchInput.trim();
      setExamListPage(0);
      if (nextSearch === examSearch && examListPage === 0) fetchExams();
      else setExamSearch(nextSearch);
    };

    return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <section aria-label="Filter examinations" style={{ backgroundColor: 'var(--panel-bg)', padding: '18px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="search" aria-label="Search examinations by title, class, or section" placeholder="Title, class, or section" maxLength={100} value={examSearchInput} disabled={listState.loading} onChange={event => setExamSearchInput(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); applySearch(); }
          }} style={{ flex: 1, minWidth: '220px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)' }} />
          <button type="button" className="btn-outline" disabled={listState.loading} onClick={applySearch}>Search</button>
          {(examSearch || examSearchInput) && <button type="button" className="btn-outline" disabled={listState.loading} onClick={() => {
            setExamSearchInput('');
            setExamSearch('');
            setExamListPage(0);
          }}>Clear search</button>}
          <select aria-label="Filter examinations by status" value={examStatusFilter} disabled={listState.loading} onChange={event => {
            setExamStatusFilter(event.target.value);
            setExamListPage(0);
          }} style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', backgroundColor: 'white' }}>
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="ACTIVE">Active</option>
            <option value="ENDED">Ended</option>
          </select>
        </div>
        <div role="status" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '12px', color: 'var(--text-muted)', fontSize: '0.9rem', flexWrap: 'wrap' }}>
          <span>Showing confirmed examinations {confirmedFirstRow}-{confirmedLastRow} of {examListTotal.toLocaleString()}.</span>
          {(listState.loading || queryChanged) && <span>Loading requested examination page…</span>}
        </div>
        {queryChanged && listState.error && <p role="alert" style={{ color: 'var(--danger)', marginBottom: 0 }}>The cards below are the last confirmed page. Management actions are disabled until the requested page loads.</p>}
      </section>

    <div aria-busy={listState.loading} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 350px), 1fr))', gap: '24px' }}>
      {/* Create New Exam Card */}
      <div className="animate-fade-in" style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '2px dashed var(--border-color)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <h3 style={{ marginBottom: '20px', color: 'var(--text-main)', textAlign: 'center' }}>Create New Exam</h3>
        <p style={{ color: 'var(--text-muted)', textAlign: 'center', marginBottom: '20px' }}>Exams are now created by selecting questions from the Question Bank.</p>
        <button className="btn-primary" onClick={() => setActiveTab('QUESTION_BANK')} style={{ padding: '12px 24px' }}>
          Go to Question Bank
        </button>
      </div>

      {/* Existing Exams List */}
      {exams.map(exam => (
        <div key={exam.id} className="admin-exam-card animate-fade-in" style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02), 0 10px 15px rgba(0,0,0,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
            <h3 style={{ margin: 0, color: 'var(--text-main)', fontSize: '1.2rem', fontWeight: 'bold' }}>{exam.title}</h3>
            <span style={{ padding: '6px 12px', borderRadius: '20px', fontSize: '0.8rem', fontWeight: 'bold', backgroundColor: exam.status === 'ACTIVE' ? 'rgba(34, 197, 94, 0.1)' : exam.status === 'ENDED' ? 'rgba(100, 116, 139, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: exam.status === 'ACTIVE' ? 'var(--success)' : exam.status === 'ENDED' ? 'var(--text-muted)' : 'var(--danger)' }}>
              {exam.status}
            </span>
          </div>
          
          <div style={{ flex: 1 }}>
            {exam.class && exam.section && (
              <div style={{ marginBottom: '12px' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--primary)', backgroundColor: 'rgba(37,99,235,0.08)', padding: '4px 10px', borderRadius: '4px', fontWeight: 'bold' }}>
                  🏫 {exam.class} | Section {exam.section}
                </span>
              </div>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginBottom: '5px' }}>Duration & Questions:</p>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--primary)', marginBottom: '8px' }}>
              ⏱️ {exam.questionsData?.duration || 180} mins / 🔢 {exam.questionsData?.totalQuestions || 0} Qs
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '5px' }}>Created: {new Date(exam.created_at).toLocaleDateString()}</p>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '20px', width: '100%' }}>
            <button className="btn-outline" disabled={rowActionsDisabled} style={{ flex: 1, padding: '10px' }} onClick={() => setActiveExamId(exam.id)}>
              Manage ➔
            </button>
            <button className="btn-outline" disabled={rowActionsDisabled} aria-label={`Delete ${exam.title}`} style={{ padding: '10px', color: 'var(--danger)', borderColor: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => handleDeleteExam(exam.id)} title="Delete Exam">
              🗑️
            </button>
          </div>
        </div>
      ))}
    </div>
      {exams.length === 0 && !listState.loading && <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No examinations match the current filters.</p>}
      <nav aria-label="Examination list pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
        <button type="button" className="btn-outline" disabled={examListPage <= 0 || rowActionsDisabled} onClick={() => setExamListPage(page => Math.max(0, page - 1))}>Previous</button>
        <span>Page {examListPage + 1} of {totalPages}</span>
        <button type="button" className="btn-outline" disabled={examListPage + 1 >= totalPages || rowActionsDisabled} onClick={() => setExamListPage(page => Math.min(totalPages - 1, page + 1))}>Next</button>
      </nav>
    </div>
    );
  };

  const loadCompleteResultsForExport = async (examId, expectedCount) => {
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20000) {
      throw new Error('CSV export supports between 1 and 20,000 results.');
    }
    const pages = [];
    let subjects = null;
    const maximumPages = Math.ceil(expectedCount / RESULT_EXPORT_PAGE_SIZE);
    let afterCursor = null;
    for (let page = 0; page < maximumPages; page += 1) {
      const { data, error } = await supabase.rpc('get_admin_exam_results_export_page', {
        exam_id_param: examId,
        after_student_id_param: afterCursor,
        page_size_param: RESULT_EXPORT_PAGE_SIZE,
        expected_result_count_param: expectedCount
      });
      if (error) throw error;
      const parsed = parseResultExportPageResponse(data, { expectedCount, pageSize: RESULT_EXPORT_PAGE_SIZE, afterCursor });
      if (subjects === null) subjects = parsed.subjects;
      else if (JSON.stringify(subjects) !== JSON.stringify(parsed.subjects)) throw new Error('The examination subjects changed while the export was being prepared.');
      pages.push(parsed.rows);
      afterCursor = parsed.nextCursor;
      if (!parsed.hasMore) break;
      if (page === maximumPages - 1) throw new Error('The export returned more results than expected.');
    }
    return { results: validateCompleteResultExport(pages, expectedCount), subjects: subjects || [] };
  };

  const authorizeResultExport = async (examId, format, resultCount) => {
    const { data, error } = await supabase.rpc('record_result_export', {
      exam_id_param: examId,
      export_format_param: format,
      expected_result_count_param: resultCount
    });
    if (error || !data?.authorized || Number(data.result_count) !== resultCount) {
      const message = error?.message || 'The server did not authorize this export.';
      if (/result set changed/i.test(message)) await fetchResults(examId);
      await customAlert(`Export blocked: ${message}`);
      return false;
    }
    return true;
  };

  const downloadLeaderboardCsv = async (examId, expectedCount, examTitle) => {
    if (csvDownloadInFlight.current) return;
    csvDownloadInFlight.current = true;
    setIsDownloadingCSV(true);
    try {
      const { results, subjects } = await loadCompleteResultsForExport(examId, expectedCount);
      const csvContent = buildLeaderboardCsv(results, subjects);
      if (!await authorizeResultExport(examId, 'CSV', results.length)) return;
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
      const encodedUri = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', encodedUri);
      link.setAttribute('download', `${safeDownloadName(examTitle)}_Leaderboard.csv`);
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        document.body.removeChild(link);
        URL.revokeObjectURL(encodedUri);
      }
    } catch (error) {
      console.error('CSV generation failed:', error);
      await customAlert(`Failed to download CSV: ${error.message}`);
    } finally {
      csvDownloadInFlight.current = false;
      setIsDownloadingCSV(false);
    }
  };

  const [isDownloadingCSV, setIsDownloadingCSV] = useState(false);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);

  const downloadLeaderboardPDF = async (examId, expectedCount, examTitle) => {
    if (pdfDownloadInFlight.current) return;
    if (expectedCount > MAX_PDF_RESULT_ROWS) {
      await customAlert(`PDF export is limited to ${MAX_PDF_RESULT_ROWS} results. Download CSV for larger cohorts.`);
      return;
    }
    pdfDownloadInFlight.current = true;
    setIsDownloadingPDF(true);
    
    try {
      const { results, subjects } = await loadCompleteResultsForExport(examId, expectedCount);
      const validation = validatePdfExport(results, subjects, examTitle);
      if (!validation.ok) throw new Error(validation.error);
      const [{ jsPDF }, { default: autoTable }] = await Promise.all([
        import('jspdf'),
        import('jspdf-autotable')
      ]);
      const { doc, filename } = createLeaderboardPdfDocument({
        PdfConstructor: jsPDF,
        autoTable,
        results: validation.results,
        subjects: validation.subjects,
        examTitle
      });
      if (!await authorizeResultExport(examId, 'PDF', results.length)) return;
      doc.save(filename);
    } catch (err) {
      console.error("PDF generation failed:", err);
      await customAlert(`Failed to download PDF: ${err.message}`);
    } finally {
      pdfDownloadInFlight.current = false;
      setIsDownloadingPDF(false);
    }
  };

  const renderDetailView = () => {
    const exam = activeExamDetail;
    if (!exam) {
      const detailState = dataLoadState.examDetail || {};
      return (
        <div className="animate-fade-in" style={{ padding: '30px', backgroundColor: 'var(--panel-bg)', border: '1px solid var(--border-color)', borderRadius: '12px' }}>
          <button type="button" onClick={() => setActiveExamId(null)} className="btn-outline">⬅️ Back to All Exams</button>
          <p role={detailState.error ? 'alert' : 'status'} style={{ marginTop: '20px', color: detailState.error ? 'var(--danger)' : 'var(--text-muted)' }}>
            {detailState.error || 'Loading the complete examination record…'}
          </p>
          {detailState.error && <button type="button" className="btn-primary" onClick={() => fetchExamDetail(activeExamId)}>Retry exam details</button>}
        </div>
      );
    }

    const rankedResults = studentResults;
    const examSubjects = resultSubjects.length > 0 ? resultSubjects : (exam.questionsData?.subjects || []);
    const analytics = resultAnalytics;
    const resultCollectionState = dataLoadState.results || {};
    const resultQueryChanged = resultSnapshot.examId !== exam.id || resultSnapshot.page !== resultPage || resultSnapshot.search !== resultSearch;
    const resultActionsDisabled = resultQueryChanged || Boolean(resultCollectionState.loading || resultCollectionState.error);
    const exportUnavailable = Boolean(resultOverallCount === 0 || resultCollectionState.loading || resultCollectionState.error || isDownloadingCSV || isDownloadingPDF);
    const totalResultPages = Math.max(1, Math.ceil(resultPageTotal / RESULT_PAGE_SIZE));
    const confirmedResultFirst = resultPageTotal === 0 ? 0 : (resultSnapshot.page * RESULT_PAGE_SIZE) + 1;
    const confirmedResultLast = resultPageTotal === 0 ? 0 : Math.min(resultPageTotal, confirmedResultFirst + rankedResults.length - 1);
    const applyResultSearch = () => {
      const nextSearch = resultSearchInput.trim();
      setResultPage(0);
      if (nextSearch === resultSearch && resultPage === 0) fetchResults(exam.id);
      else setResultSearch(nextSearch);
    };
    return (
      <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
        <button onClick={() => setActiveExamId(null)} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '1rem', padding: '0' }} onMouseOver={(e) => e.target.style.color = 'var(--text-main)'} onMouseOut={(e) => e.target.style.color = 'var(--text-muted)'}>
          ⬅️ Back to All Exams
        </button>

        {/* Top Widgets for this Exam */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px' }}>
          {/* Exam Details Widget */}
          <div style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
             <h2 style={{ color: 'var(--text-main)', marginBottom: '15px', fontSize: '1.4rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>{exam.title}</h2>
             <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
               <div>🏫 Target Audience: <strong style={{ color: 'var(--text-main)' }}>{exam.class} - {exam.section}</strong></div>
               <div>⏱️ Duration: <strong style={{ color: 'var(--text-main)' }}>{exam.questionsData?.duration || 180} Minutes</strong></div>
               <div>⚖️ Grading: <strong style={{ color: 'var(--text-main)' }}>+{exam.questionsData?.marksCorrect || 4} / {exam.questionsData?.marksIncorrect || -1}</strong></div>
               <div>📚 Subjects: <strong style={{ color: 'var(--text-main)' }}>{exam.questionsData?.subjects?.join(', ') || 'Physics, Chemistry, Mathematics'}</strong></div>
               <div>🔢 Total Questions: <strong style={{ color: 'var(--text-main)' }}>
                 {exam.questionsData?.questions ? Object.values(exam.questionsData.questions).reduce((sum, list) => sum + list.length, 0) : 0} Questions
               </strong></div>
             </div>
          </div>

          {/* Exam Control Widget */}
          <div style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'center', border: '1px solid var(--border-color)' }}>
            <div style={{ width: '100%', textAlign: 'center' }}>
              <p style={{ color: 'var(--text-muted)', marginBottom: '20px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px', fontSize: '0.85rem' }}>Exam Status</p>
              <div style={{ padding: '15px 30px', borderRadius: '50px', backgroundColor: exam.status === 'ACTIVE' ? 'rgba(34, 197, 94, 0.1)' : exam.status === 'ENDED' ? 'rgba(100, 116, 139, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: exam.status === 'ACTIVE' ? 'var(--success)' : exam.status === 'ENDED' ? 'var(--text-muted)' : 'var(--danger)', fontWeight: 'bold', fontSize: '1.2rem', marginBottom: '30px', display: 'inline-flex', alignItems: 'center', gap: '10px' }}>
                {exam.status === 'ACTIVE' && <span style={{ width: '12px', height: '12px', borderRadius: '50%', backgroundColor: 'var(--success)', display: 'inline-block', boxShadow: '0 0 10px var(--success)' }}></span>}
                {exam.status}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', width: '100%', flexWrap: 'wrap' }}>
              <button 
                onClick={() => handlePreflightCheck(exam.id)}
                className="btn-outline"
                style={{ padding: '12px 18px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.95rem', fontWeight: 600 }}
                title="Run Preflight Validation"
              >
                🔍 Preflight
              </button>
              <button 
                onClick={() => toggleExamStatus(exam.id)} 
                style={{ padding: '16px 28px', borderRadius: '8px', border: 'none', fontWeight: 'bold', fontSize: '1.1rem', cursor: 'pointer', backgroundColor: exam.status === 'ACTIVE' ? 'var(--danger)' : 'var(--success)', color: 'white', flex: 1, minWidth: '140px', boxShadow: '0 4px 15px rgba(0,0,0,0.1)', transition: 'all 0.2s' }}
                onMouseOver={(e) => e.target.style.transform = 'translateY(-2px)'}
                onMouseOut={(e) => e.target.style.transform = 'translateY(0)'}
              >
                {exam.status === 'ACTIVE' ? '🛑 End Exam' : '▶️ Start Exam'}
              </button>
              <button 
                onClick={() => handleDeleteExam(exam.id)}
                className="btn-outline" 
                style={{ color: 'var(--danger)', borderColor: 'var(--danger)', padding: '16px 20px', display: 'flex', alignItems: 'center' }}
                title="Delete Exam"
              >
                🗑️
              </button>
            </div>
          </div>
        </div>

        {analytics && (
          <div style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '1px solid var(--border-color)' }}>
            <h3 style={{ color: 'var(--text-main)', margin: 0, marginBottom: '20px', fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span>📈</span> Analytics & Insights
            </h3>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '30px' }}>
              <div style={{ padding: '20px', backgroundColor: 'rgba(59, 130, 246, 0.05)', borderRadius: '8px', border: '1px solid rgba(59, 130, 246, 0.2)', textAlign: 'center' }}>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', fontWeight: 'bold' }}>Average Score</p>
                <p style={{ margin: '10px 0 0', fontSize: '2rem', fontWeight: 'bold', color: 'var(--primary)' }}>{analytics.averageScore.toFixed(1)}</p>
              </div>
              <div style={{ padding: '20px', backgroundColor: 'rgba(16, 185, 129, 0.05)', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.2)', textAlign: 'center' }}>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', fontWeight: 'bold' }}>Highest Score</p>
                <p style={{ margin: '10px 0 0', fontSize: '2rem', fontWeight: 'bold', color: 'var(--success)' }}>{analytics.highestScore}</p>
              </div>
              <div style={{ padding: '20px', backgroundColor: 'rgba(239, 68, 68, 0.05)', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.2)', textAlign: 'center' }}>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem', textTransform: 'uppercase', fontWeight: 'bold' }}>Lowest Score</p>
                <p style={{ margin: '10px 0 0', fontSize: '2rem', fontWeight: 'bold', color: 'var(--danger)' }}>{analytics.lowestScore}</p>
              </div>
            </div>

            <React.Suspense fallback={<p role="status">Loading analytics charts…</p>}>
              <AdminAnalyticsCharts distribution={analytics.distribution} subjectAverages={analytics.subjectAverages} />
            </React.Suspense>
            {analytics.excludedFromDistribution > 0 && (
              <p role="alert" style={{ color: 'var(--danger)', marginBottom: 0 }}>
                {analytics.excludedFromDistribution} result(s) were excluded from percentage distribution because their maximum score is zero or invalid.
              </p>
            )}
          </div>
        )}



        {/* Exam Question Paper Archive */}
        <ExamQuestionsArchive exam={exam} />

        {/* Leaderboard Section */}
        <div style={{ backgroundColor: 'var(--panel-bg)', padding: '30px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)', border: '1px solid var(--border-color)', flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
            <h3 style={{ color: 'var(--text-main)', margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span>🏆</span> {exam.title} - Leaderboard
            </h3>
            <div style={{ display: 'flex', gap: '10px' }}>
              {resultOverallCount > 0 && (
                <>
                  <button 
                    onClick={() => downloadLeaderboardCsv(exam.id, resultOverallCount, exam.title)}
                    disabled={exportUnavailable}
                    title={exportUnavailable ? 'Wait for a complete, valid result list before exporting.' : 'Download UTF-8 CSV'}
                    style={{ background: '#10b981', border: 'none', color: 'white', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', transition: 'all 0.2s', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }} 
                    onMouseOver={(e) => e.target.style.opacity = '0.9'} 
                    onMouseOut={(e) => e.target.style.opacity = '1'}
                  >
                    {isDownloadingCSV ? '⏳ Preparing CSV…' : '📥 Download CSV'}
                  </button>
                  <button 
                    onClick={() => downloadLeaderboardPDF(exam.id, resultOverallCount, exam.title)}
                    disabled={isDownloadingPDF || exportUnavailable}
                    aria-busy={isDownloadingPDF}
                    title={exportUnavailable ? 'Wait for a complete, valid result list before exporting.' : 'Download printable PDF'}
                    style={{ background: 'var(--primary)', border: 'none', color: 'white', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', transition: 'all 0.2s', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '6px' }} 
                    onMouseOver={(e) => e.target.style.opacity = '0.9'} 
                    onMouseOut={(e) => e.target.style.opacity = '1'}
                  >
                    {isDownloadingPDF ? '⏳ Generating PDF...' : '📄 Download PDF'}
                  </button>
                </>
              )}
              <span style={{ border: '1px solid var(--border-color)', color: 'var(--text-muted)', padding: '8px 16px', borderRadius: '6px', fontWeight: 'bold', fontSize: '0.9rem' }}>
                🔒 Results retained
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <input type="search" aria-label="Search leaderboard by student name or ID" placeholder="Student name or ID" maxLength={100} value={resultSearchInput} disabled={resultCollectionState.loading} onChange={event => setResultSearchInput(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); applyResultSearch(); }
            }} style={{ flex: 1, minWidth: '220px', padding: '9px 12px', borderRadius: '6px', border: '1px solid var(--border-color)' }} />
            <button type="button" className="btn-outline" disabled={resultCollectionState.loading} onClick={applyResultSearch}>Search</button>
            {(resultSearch || resultSearchInput) && <button type="button" className="btn-outline" disabled={resultCollectionState.loading} onClick={() => {
              setResultSearchInput('');
              setResultSearch('');
              setResultPage(0);
            }}>Clear search</button>}
          </div>
          <div role="status" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            <span>Showing confirmed results {confirmedResultFirst}-{confirmedResultLast} of {resultPageTotal.toLocaleString()} matching result(s); {resultOverallCount.toLocaleString()} total submission(s).</span>
            {(resultCollectionState.loading || resultQueryChanged) && <span>Loading requested leaderboard page…</span>}
          </div>
          {resultCollectionState.error && (
            <div role="alert" style={{ marginBottom: '20px', padding: '12px 16px', borderRadius: '8px', color: 'var(--danger)', background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)' }}>
              {resultCollectionState.error} {resultQueryChanged ? 'The table below is the last confirmed page and its navigation is disabled.' : ''}
            </div>
          )}
          
          {rankedResults.length === 0 ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 40px', color: 'var(--text-muted)', backgroundColor: 'var(--bg-color)', borderRadius: '8px', border: '2px dashed var(--border-color)' }}>
              <span aria-hidden="true" style={{ fontSize: '3rem', marginBottom: '15px' }}>📭</span>
              <p style={{ fontSize: '1.1rem' }}>{resultOverallCount === 0 ? 'No submissions yet for this exam.' : 'No results match this search.'}</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: '8px', border: '1px solid var(--border-color)', backgroundColor: 'var(--bg-color)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '2px solid var(--border-color)', color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '0.85rem', letterSpacing: '1px' }}>
                    <th style={{ padding: '16px', width: '80px', textAlign: 'center' }}>Rank</th>
                    <th style={{ padding: '16px' }}>Student Name</th>
                    <th style={{ padding: '16px' }}>Student ID</th>
                    {examSubjects.map(sub => (
                      <React.Fragment key={sub}>
                        <th style={{ padding: '16px', textAlign: 'center' }}>{sub} Marks</th>
                        <th style={{ padding: '16px', textAlign: 'center' }}>{sub} Rank</th>
                      </React.Fragment>
                    ))}
                    <th style={{ padding: '16px', textAlign: 'right' }}>Total Score</th>
                  </tr>
                </thead>
                <tbody style={{ backgroundColor: 'var(--panel-bg)' }}>
                  {rankedResults.map((result) => (
                    <tr key={result.studentId} style={{ borderBottom: '1px solid var(--border-color)', backgroundColor: result.totalRank === 1 ? 'rgba(251, 191, 36, 0.05)' : 'transparent', transition: 'background-color 0.2s' }} onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'} onMouseOut={(e) => e.currentTarget.style.backgroundColor = result.totalRank === 1 ? 'rgba(251, 191, 36, 0.05)' : 'transparent'}>
                      <td style={{ padding: '16px', textAlign: 'center', fontWeight: 'bold', fontSize: '1.2rem', color: result.totalRank === 1 ? '#f59e0b' : result.totalRank === 2 ? '#94a3b8' : result.totalRank === 3 ? '#b45309' : 'var(--text-muted)' }}>
                        {result.totalRank === 1 ? '🥇' : result.totalRank === 2 ? '🥈' : result.totalRank === 3 ? '🥉' : `#${result.totalRank}`}
                      </td>
                      <td style={{ padding: '16px', fontWeight: '600', color: 'var(--text-main)', fontSize: '1.1rem' }}>{result.studentName}</td>
                      <td style={{ padding: '16px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{result.studentId}</td>
                      {examSubjects.map(sub => {
                        const score = result.subjectScores?.[sub] ?? 0;
                        const sRank = result.subjectRanks?.[sub] ?? 'N/A';
                        return (
                          <React.Fragment key={sub}>
                            <td style={{ padding: '16px', textAlign: 'center' }}>{score}</td>
                            <td style={{ padding: '16px', textAlign: 'center', fontWeight: '500', color: 'var(--primary)' }}>
                              {sRank !== 'N/A' ? `#${sRank}` : 'N/A'}
                            </td>
                          </React.Fragment>
                        );
                      })}
                      <td style={{ padding: '16px', textAlign: 'right', fontWeight: 'bold', color: 'var(--primary)', fontSize: '1.2rem' }}>
                        {result.totalScore} <span style={{ fontSize: '0.9rem', color: 'var(--text-muted)', fontWeight: 'normal' }}>/ {result.maxScore}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav aria-label="Leaderboard pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '18px' }}>
            <button type="button" className="btn-outline" disabled={resultPage <= 0 || resultActionsDisabled} onClick={() => setResultPage(page => Math.max(0, page - 1))}>Previous</button>
            <span>Page {resultPage + 1} of {totalResultPages}</span>
            <button type="button" className="btn-outline" disabled={resultPage + 1 >= totalResultPages || resultActionsDisabled} onClick={() => setResultPage(page => Math.min(totalResultPages - 1, page + 1))}>Next</button>
          </nav>
        </div>
      </div>
    );
  };

  const renderQuestionBankView = () => {
    const groupedQuestions = {};
    questionBank.forEach(q => {
      const subj = q.subject || 'General';
      if (!groupedQuestions[subj]) groupedQuestions[subj] = [];
      groupedQuestions[subj].push(q);
    });

    // Sort questions within each subject by question number
    Object.keys(groupedQuestions).forEach(subj => {
      groupedQuestions[subj].sort((a, b) => (a.questionNumber || 0) - (b.questionNumber || 0));
    });

    const subjectOrder = ['Maths', 'Mathematics', 'Physics', 'Chemistry'];
    const sortedSubjects = Object.keys(groupedQuestions).sort((a, b) => {
      const idxA = subjectOrder.indexOf(a);
      const idxB = subjectOrder.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });
    const totalPages = Math.max(1, Math.ceil(questionBankTotal / QUESTION_BANK_PAGE_SIZE));
    const confirmedFirstRow = questionBankTotal === 0 ? 0 : (questionBankSnapshot.page * QUESTION_BANK_PAGE_SIZE) + 1;
    const confirmedLastRow = questionBankTotal === 0 ? 0 : Math.min(questionBankTotal, confirmedFirstRow + questionBank.length - 1);
    const questionQueryChanged = questionBankSnapshot.page !== questionBankPage
      || questionBankSnapshot.search !== questionSearch
      || questionBankSnapshot.subject !== questionSubjectFilter
      || questionBankSnapshot.type !== questionTypeFilter;
    const questionState = dataLoadState.questions || {};
    const questionActionsDisabled = questionQueryChanged || Boolean(questionState.loading || questionState.error);
    const pageIds = questionBank.map(question => question.docId);
    const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedQuestions.includes(id));

    const applyQuestionSearch = () => {
      const nextSearch = questionSearchInput.trim();
      setQuestionBankPage(0);
      if (nextSearch === questionSearch && questionBankPage === 0) fetchQuestionBank();
      else setQuestionSearch(nextSearch);
    };

    return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%' }}>
      {editingQuestion && (
        <QuestionEditor 
          question={editingQuestion} 
          existingQuestions={questionBank}
          onSave={handleSaveQuestion} 
          onCancel={() => setEditingQuestion(null)} 
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '24px' }}>
        <div style={{ backgroundColor: 'var(--panel-bg)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
          <h2 style={{ margin: '0 0 20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span>📚</span> Question Bank
          </h2>

          <div role="status" style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '12px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            <span>Showing confirmed questions {confirmedFirstRow}-{confirmedLastRow} of {questionBankTotal.toLocaleString()}. {selectedQuestions.length} selected across all pages.</span>
            {(questionState.loading || questionQueryChanged) && <span>Loading requested Question Bank page…</span>}
          </div>
          {questionQueryChanged && questionState.error && (
            <p role="alert" style={{ color: 'var(--danger)' }}>The list below is the last confirmed page. Question actions are disabled until the requested page loads.</p>
          )}

          <fieldset disabled={questionActionsDisabled} aria-busy={questionState.loading} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <div>
              <input type="checkbox" id="selectAll" 
                checked={allPageSelected}
                disabled={pageIds.length === 0}
                onChange={(e) => {
                  const nextChecked = e.currentTarget.checked;
                  setSelectedQuestions(current => nextChecked
                    ? [...new Set([...current, ...pageIds])]
                    : current.filter(id => !pageIds.includes(id)));
                }}
              />
              <label htmlFor="selectAll" style={{ marginLeft: '8px', fontWeight: 'bold' }}>Select this page ({questionBank.length})</label>
            </div>
            {questionBankTotal > 0 && (
              <button 
                onClick={handleDeleteAllQuestions} 
                style={{ background: 'none', border: '1px solid var(--danger)', color: 'var(--danger)', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold', transition: 'all 0.2s', marginLeft: '10px' }}
                onMouseOver={(e) => { e.target.style.backgroundColor = 'var(--danger)'; e.target.style.color = 'white'; }}
                onMouseOut={(e) => { e.target.style.backgroundColor = 'transparent'; e.target.style.color = 'var(--danger)'; }}
              >
                🗑️ Delete All Questions
              </button>
            )}
            <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
              <button 
                className="btn-outline" 
                onClick={() => handleAddBlankQuestion('MCQ')}
                style={{ padding: '6px 12px', fontSize: '0.85rem', fontWeight: 'bold', borderColor: 'var(--primary)', color: 'var(--primary)', cursor: 'pointer' }}
              >
                + Create Blank MCQ
              </button>
              <button 
                className="btn-primary" 
                onClick={() => handleAddBlankQuestion('NUMERICAL')}
                style={{ padding: '6px 12px', fontSize: '0.85rem', fontWeight: 'bold', backgroundColor: '#d97706', borderColor: '#d97706', color: 'white', cursor: 'pointer' }}
              >
                + Create Blank Numerical (NAT)
              </button>
            </div>
          </div>

          <div style={{ marginBottom: '20px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input 
              type="search"
              aria-label="Search questions by number, text, or subject"
              placeholder="Search by question number (e.g. 15), text, or subject..." 
              maxLength={100}
              value={questionSearchInput}
              onChange={(e) => setQuestionSearchInput(e.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyQuestionSearch(); } }}
              style={{ flex: 1, minWidth: '240px', padding: '10px 15px', borderRadius: '8px', border: '1px solid var(--border-color)', fontSize: '0.95rem', outline: 'none' }}
            />
            <button type="button" className="btn-outline" onClick={applyQuestionSearch}>Search</button>
            {(questionSearch || questionSearchInput) && <button type="button" className="btn-outline" onClick={() => {
              setQuestionSearchInput('');
              setQuestionSearch('');
              setQuestionBankPage(0);
            }}>Clear search</button>}
            <input type="text" aria-label="Filter questions by exact subject" placeholder="Exact subject" maxLength={100} value={questionSubjectInput} onChange={event => setQuestionSubjectInput(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setQuestionSubjectFilter(questionSubjectInput.trim());
                setQuestionBankPage(0);
              }
            }} style={{ width: '150px', padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)' }} />
            <button type="button" className="btn-outline" onClick={() => {
              setQuestionSubjectFilter(questionSubjectInput.trim());
              setQuestionBankPage(0);
            }}>Apply subject</button>
            {(questionSubjectFilter || questionSubjectInput) && <button type="button" className="btn-outline" onClick={() => {
              setQuestionSubjectInput('');
              setQuestionSubjectFilter('');
              setQuestionBankPage(0);
            }}>Clear subject</button>}
            <select aria-label="Filter questions by type" value={questionTypeFilter} onChange={event => {
              setQuestionTypeFilter(event.target.value);
              setQuestionBankPage(0);
            }} style={{ padding: '10px', borderRadius: '8px', border: '1px solid var(--border-color)', backgroundColor: 'white' }}>
              <option value="">All types</option>
              <option value="MCQ">MCQ</option>
              <option value="NUMERICAL">Numerical</option>
            </select>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {questionBank.length === 0 ? (
              <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                {questionBankTotal === 0 && !questionSearch && !questionSubjectFilter && !questionTypeFilter ? 'No questions in bank. Use the Question Editor to create new questions.' : 'No matching questions found.'}
              </div>
            ) : (
              sortedSubjects.map(subject => (
                <div key={subject}>
                  <h3 style={{ margin: '0 0 15px 0', paddingBottom: '8px', borderBottom: '2px solid var(--border-color)', color: 'var(--text-main)' }}>{subject}</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
                    {groupedQuestions[subject].map(q => (
                      <div key={q.docId} style={{ display: 'flex', gap: '15px', padding: '15px', border: '1px solid var(--border-color)', borderRadius: '8px', backgroundColor: selectedQuestions.includes(q.docId) ? 'rgba(37, 99, 235, 0.05)' : 'transparent' }}>
                        <input type="checkbox" 
                          checked={selectedQuestions.includes(q.docId)}
                          aria-label={`Select question ${q.questionNumber || q.docId}: ${q.text.slice(0, 80)}`}
                          onChange={(e) => {
                            const nextChecked = e.currentTarget.checked;
                            setSelectedQuestions(current => nextChecked
                              ? [...new Set([...current, q.docId])]
                              : current.filter(id => id !== q.docId));
                          }}
                          style={{ marginTop: '5px' }}
                        />
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                              <span style={{ fontSize: '0.8rem', fontWeight: 'bold', color: 'var(--primary)', backgroundColor: 'rgba(37, 99, 235, 0.1)', padding: '2px 8px', borderRadius: '10px' }}>
                                {q.subject}
                              </span>
                              <span style={{ fontSize: '0.75rem', fontWeight: 'bold', color: q.type === 'NUMERICAL' ? '#d97706' : 'var(--success)', backgroundColor: q.type === 'NUMERICAL' ? '#fef3c7' : 'rgba(34, 197, 94, 0.1)', padding: '2px 8px', borderRadius: '10px' }}>
                                {q.type === 'NUMERICAL' ? 'NUMERICAL VALUE' : 'MCQ'}
                              </span>
                            </div>
                            <div>
                              <button onClick={() => setEditingQuestion(q)} style={{ background: 'none', border: 'none', color: 'var(--text-main)', cursor: 'pointer', marginRight: '10px' }}>✏️ Edit</button>
                              <button onClick={() => handleDeleteQuestion(q.docId)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer' }}>🗑️</button>
                            </div>
                          </div>
                          <p style={{ margin: '10px 0', fontWeight: '500' }}>
                            {q.questionNumber && <span style={{color: 'var(--text-muted)', marginRight: '8px'}}>Q{q.questionNumber}.</span>}
                            <MathRenderer text={q.text} />
                            {q.hasImageOrDiagram && !q.questionImageUrl && <span style={{ marginLeft: '10px', fontSize: '0.85rem', color: 'var(--danger)', fontWeight: 'bold' }}>[⚠️ Requires Image Upload]</span>}
                          </p>
                          {q.questionImageUrl && (
                            <div style={{ marginBottom: '10px' }}>
                            <StorageImage src={q.questionImageUrl} alt="Question" style={{ maxHeight: '100px', maxWidth: '100%', borderRadius: '4px', border: '1px solid var(--border-color)' }} />
                            </div>
                          )}
                          {q.type === 'NUMERICAL' || !q.options || q.options.length === 0 ? (
                            <div style={{ padding: '8px 12px', backgroundColor: '#fef3c7', borderRadius: '6px', border: '1px solid #fde68a', color: '#b45309', fontWeight: 'bold', display: 'inline-block', fontSize: '0.9rem' }}>
                              🔢 Correct Numerical Answer: {q.correctAnswer}
                            </div>
                          ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.9rem', color: 'var(--text-muted)' }}>
                              {q.options.map((opt, i) => (
                                <div key={i} style={{ color: Number(q.correctAnswer) === i ? 'var(--success)' : 'inherit', fontWeight: Number(q.correctAnswer) === i ? 'bold' : 'normal', display: 'flex', flexDirection: 'column' }}>
                                  <span>{String.fromCharCode(65 + i)}) <MathRenderer text={opt} /></span>
                                  {q.optionImageUrls?.[i] && (
                                    <StorageImage src={q.optionImageUrls[i]} alt={`Option ${i}`} style={{ maxHeight: '60px', maxWidth: '100%', borderRadius: '4px', marginTop: '4px', alignSelf: 'flex-start' }} />
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          <nav aria-label="Question Bank pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '18px' }}>
            <button type="button" className="btn-outline" disabled={questionBankPage <= 0 || questionActionsDisabled} onClick={() => setQuestionBankPage(page => Math.max(0, page - 1))}>Previous</button>
            <span>Page {questionBankPage + 1} of {totalPages}</span>
            <button type="button" className="btn-outline" disabled={questionBankPage + 1 >= totalPages || questionActionsDisabled} onClick={() => setQuestionBankPage(page => Math.min(totalPages - 1, page + 1))}>Next</button>
          </nav>
          </fieldset>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>


          {/* Create Exam Card */}
          <div style={{ backgroundColor: 'var(--panel-bg)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 15px' }}>Create Exam</h3>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '15px' }}>
              Selected Questions: <strong>{selectedQuestions.length}</strong> / {MAX_EXAM_QUESTIONS}
            </p>
            <input 
              type="text" 
              placeholder="Exam Title (e.g. Midterms)" 
              value={newExamTitle}
              onChange={(e) => setNewExamTitle(e.target.value)}
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '15px', outline: 'none' }}
            />
            
            <select 
              aria-label="Target class for new exam"
              value={examTargetClass} 
              onChange={e => {
                setExamTargetClass(e.target.value);
                const cls = classes.find(c => c.name === e.target.value);
                setExamTargetSection(cls && cls.sections && cls.sections.length > 0 ? cls.sections[0] : '');
              }} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '15px', backgroundColor: 'white', outline: 'none' }}
            >
              <option value="">Select Target Class...</option>
              {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>

            <select 
              aria-label="Target section for new exam"
              value={examTargetSection} 
              disabled={!examTargetClass} 
              onChange={e => setExamTargetSection(e.target.value)} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '15px', backgroundColor: 'white', outline: 'none' }}
            >
              <option value="">Select Target Section...</option>
              {examTargetClass && 
                (classes.find(c => c.name === examTargetClass)?.sections || []).map(sec => (
                  <option key={sec} value={sec}>{sec}</option>
                ))
              }
            </select>

            <select 
              aria-label="Duration for new exam"
              value={examDuration} 
              onChange={e => setExamDuration(Number(e.target.value))} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '15px', backgroundColor: 'white', outline: 'none' }}
            >
              <option value={30}>30 Minutes</option>
              <option value={45}>45 Minutes</option>
              <option value={60}>1 Hour (60 mins)</option>
              <option value={90}>1.5 Hours (90 mins)</option>
              <option value={120}>2 Hours (120 mins)</option>
              <option value={150}>2.5 Hours (150 mins)</option>
              <option value={180}>3 Hours (180 mins)</option>
            </select>

            <select 
              aria-label="Marks for a correct answer"
              value={examMarksCorrect} 
              onChange={e => setExamMarksCorrect(Number(e.target.value))} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '15px', backgroundColor: 'white', outline: 'none' }}
            >
              <option value={1}>+1 Mark per Correct</option>
              <option value={2}>+2 Marks per Correct</option>
              <option value={3}>+3 Marks per Correct</option>
              <option value={4}>+4 Marks per Correct</option>
              <option value={5}>+5 Marks per Correct</option>
            </select>

            <select 
              aria-label="Marks for an incorrect answer"
              value={examMarksIncorrect} 
              onChange={e => setExamMarksIncorrect(Number(e.target.value))} 
              style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-color)', marginBottom: '15px', backgroundColor: 'white', outline: 'none' }}
            >
              <option value={0}>0 Negative Marks</option>
              <option value={-0.25}>-0.25 Negative Marks</option>
              <option value={-0.5}>-0.5 Negative Marks</option>
              <option value={-1}>-1 Negative Mark</option>
              <option value={-2}>-2 Negative Marks</option>
            </select>

            <button className="btn-success" onClick={handleCreateExamFromSelected} style={{ width: '100%', padding: '12px' }} disabled={selectedQuestions.length === 0 || selectedQuestions.length > MAX_EXAM_QUESTIONS || isCreatingExam}>
              {isCreatingExam ? 'Creating…' : 'Create Exam'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  };

  const failedDataLoads = Object.entries(dataLoadState).filter(([, state]) => state?.error);
  const isAnyDataLoading = Object.values(dataLoadState).some(state => state?.loading);

  const retryFailedDataLoads = async () => {
    const retries = failedDataLoads.map(([key]) => {
      if (key === 'counts') return fetchTableCounts();
      if (key === 'exams') return fetchExams();
      if (key === 'examDetail') return activeExamId ? fetchExamDetail(activeExamId) : Promise.resolve(true);
      if (key === 'results') return activeExamId ? fetchResults(activeExamId) : Promise.resolve(true);
      if (key === 'students') return fetchStudents();
      if (key === 'questions') return fetchQuestionBank();
      if (key === 'classes') return fetchClasses();
      return Promise.resolve(true);
    });
    await Promise.all(retries);
  };

  if (adminAccess !== 'GRANTED') {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', backgroundColor: '#f8fafc' }}>
        <div style={{ textAlign: 'center', maxWidth: '520px', padding: '24px' }}>
          <p role={adminAccess === 'ERROR' ? 'alert' : 'status'}>
            {adminAccess === 'CHECKING' ? 'Verifying administrator access…' : adminAccessError || 'Access denied.'}
          </p>
          {adminAccess === 'ERROR' && (
            <button type="button" className="btn-primary" onClick={() => setAdminVerificationAttempt(value => value + 1)}>
              Retry verification
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <div className="admin-dashboard-shell" style={{ display: 'flex', height: '100vh', backgroundColor: '#f8fafc', overflow: 'hidden', fontFamily: "'Inter', sans-serif" }}>
      {/* Sidebar */}
      <aside className="admin-dashboard-sidebar" style={{ width: '280px', backgroundColor: '#0f172a', color: 'white', display: 'flex', flexDirection: 'column', boxShadow: '4px 0 15px rgba(0,0,0,0.1)', zIndex: 20 }}>
        <div className="admin-sidebar-brand" style={{ padding: '30px 24px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: '8px', backgroundColor: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.5rem', boxShadow: '0 4px 10px rgba(37,99,235,0.3)' }}>
            👨‍💻
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 'bold', letterSpacing: '0.5px' }}>Admin Portal</h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#94a3b8', marginTop: '2px' }}>Control Center</p>
          </div>
        </div>

        <nav className="admin-sidebar-nav" aria-label="Administrator sections" style={{ flex: 1, padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button 
            onClick={() => { setActiveTab('DASHBOARD'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'DASHBOARD' && !activeExamId ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              color: activeTab === 'DASHBOARD' && !activeExamId ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'DASHBOARD' && !activeExamId ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'DASHBOARD' && !activeExamId ? '3px solid var(--primary)' : '3px solid transparent'
            }}
            onMouseOver={(e) => { if (activeTab !== 'DASHBOARD' || activeExamId) { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'white'; } }}
            onMouseOut={(e) => { if (activeTab !== 'DASHBOARD' || activeExamId) { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
          >
            <span style={{ fontSize: '1.2rem' }}>📊</span> Dashboard
          </button>

          <button 
            onClick={() => { setActiveTab('STUDENTS'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'STUDENTS' ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              color: activeTab === 'STUDENTS' ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'STUDENTS' ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'STUDENTS' ? '3px solid var(--primary)' : '3px solid transparent'
            }}
            onMouseOver={(e) => { if (activeTab !== 'STUDENTS') { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'white'; } }}
            onMouseOut={(e) => { if (activeTab !== 'STUDENTS') { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
          >
            <span style={{ fontSize: '1.2rem' }}>👥</span> Students
          </button>

          <button 
            onClick={() => { setActiveTab('CLASSES'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'CLASSES' ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              color: activeTab === 'CLASSES' ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'CLASSES' ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'CLASSES' ? '3px solid var(--primary)' : '3px solid transparent'
            }}
            onMouseOver={(e) => { if (activeTab !== 'CLASSES') { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'white'; } }}
            onMouseOut={(e) => { if (activeTab !== 'CLASSES') { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
          >
            <span style={{ fontSize: '1.2rem' }}>🏫</span> Classes
          </button>
          
          <button 
            onClick={() => { setActiveTab('QUESTION_BANK'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'QUESTION_BANK' ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              color: activeTab === 'QUESTION_BANK' ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'QUESTION_BANK' ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'QUESTION_BANK' ? '3px solid var(--primary)' : '3px solid transparent'
            }}
            onMouseOver={(e) => { if (activeTab !== 'QUESTION_BANK') { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'white'; } }}
            onMouseOut={(e) => { if (activeTab !== 'QUESTION_BANK') { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
          >
            <span style={{ fontSize: '1.2rem' }}>📚</span> Question Bank
          </button>

          <button 
            onClick={() => { setActiveTab('AI_IMPORTER'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'AI_IMPORTER' ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              color: activeTab === 'AI_IMPORTER' ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'AI_IMPORTER' ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'AI_IMPORTER' ? '3px solid var(--primary)' : '3px solid transparent'
            }}
            onMouseOver={(e) => { if (activeTab !== 'AI_IMPORTER') { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'white'; } }}
            onMouseOut={(e) => { if (activeTab !== 'AI_IMPORTER') { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
          >
            <span style={{ fontSize: '1.2rem' }}>📋</span> Reviewed JSON Import
          </button>

          <button 
            onClick={() => { setActiveTab('OPERATIONS'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'OPERATIONS' ? 'rgba(37, 99, 235, 0.2)' : 'transparent',
              color: activeTab === 'OPERATIONS' ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'OPERATIONS' ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'OPERATIONS' ? '3px solid var(--primary)' : '3px solid transparent'
            }}
          >
            <span style={{ fontSize: '1.2rem' }}>🩺</span> Operations & Audit
          </button>

          <button 
            onClick={() => { setActiveTab('DB_CLEANER'); setActiveExamId(null); }}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none', cursor: 'pointer',
              backgroundColor: activeTab === 'DB_CLEANER' ? 'rgba(239, 68, 68, 0.15)' : 'transparent',
              color: activeTab === 'DB_CLEANER' ? 'white' : '#94a3b8',
              fontWeight: activeTab === 'DB_CLEANER' ? 'bold' : 'normal',
              textAlign: 'left', fontSize: '1rem', transition: 'all 0.2s',
              borderLeft: activeTab === 'DB_CLEANER' ? '3px solid var(--danger)' : '3px solid transparent'
            }}
            onMouseOver={(e) => { if (activeTab !== 'DB_CLEANER') { e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'white'; } }}
            onMouseOut={(e) => { if (activeTab !== 'DB_CLEANER') { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; } }}
          >
            <span style={{ fontSize: '1.2rem' }}>🧹</span> Database Cleaner
          </button>

          {activeExamId && (
            <div style={{ 
              display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 16px', 
              borderRadius: '8px', border: 'none',
              backgroundColor: 'rgba(37, 99, 235, 0.2)',
              color: 'white',
              fontWeight: 'bold',
              textAlign: 'left', fontSize: '1rem',
              borderLeft: '3px solid var(--primary)',
              marginLeft: '20px'
            }}>
              <span style={{ fontSize: '1.2rem' }}>📝</span> Exam Detail
            </div>
          )}
        </nav>

        <div className="admin-sidebar-footer" style={{ padding: '24px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <button 
            onClick={async () => { 
              safeStorageSet('sessionStorage', 'examState', 'AUTH');
              safeStorageRemove('sessionStorage', 'currentStudent');
              safeStorageRemove('sessionStorage', 'currentAdmin');
              await supabase.auth.signOut({ scope: 'local' }).catch(console.error);
              onBackToLogin(); 
            }} 
            style={{ 
              width: '100%', display: 'flex', alignItems: 'center', gap: '12px', 
              padding: '12px 16px', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.3)', 
              backgroundColor: 'rgba(239, 68, 68, 0.05)', color: '#ef4444', 
              cursor: 'pointer', fontWeight: 'bold', fontSize: '1rem', transition: 'all 0.2s'
            }}
            onMouseOver={(e) => { e.currentTarget.style.backgroundColor = '#ef4444'; e.currentTarget.style.color = 'white'; }}
            onMouseOut={(e) => { e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.05)'; e.currentTarget.style.color = '#ef4444'; }}
          >
            <span style={{ fontSize: '1.2rem' }}>🚪</span> Logout
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="admin-dashboard-main" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        {/* Top bar for main content */}
        <header className="admin-dashboard-topbar" style={{ padding: '20px 40px', backgroundColor: 'white', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, zIndex: 10 }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', color: '#1e293b', fontWeight: 'bold' }}>
            {activeTab === 'STUDENTS' ? 'Student Management' : activeTab === 'CLASSES' ? 'Class Management' : activeTab === 'QUESTION_BANK' ? 'Question Bank' : activeTab === 'AI_IMPORTER' ? 'Reviewed JSON Import' : activeTab === 'OPERATIONS' ? 'Operations & Audit' : activeTab === 'DB_CLEANER' ? 'Database Maintenance & Cleaner' : activeExamId ? 'Exam Management' : 'Dashboard Overview'}
          </h1>
          <div className="admin-identity" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '50%', backgroundColor: 'var(--primary)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold' }}>
              👑
            </div>
            <span style={{ fontWeight: '600', color: '#475569' }}>Administrator</span>
          </div>
        </header>

        <div className="admin-dashboard-content" style={{ padding: '40px', flex: 1, maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
          {isAnyDataLoading && <p role="status" aria-live="polite">Refreshing administrator data…</p>}
          {failedDataLoads.length > 0 && (
            <section role="alert" style={{ marginBottom: '20px', padding: '14px 16px', border: '1px solid #f87171', borderRadius: '8px', background: '#fef2f2', color: '#991b1b' }}>
              <strong>Some administrator data could not be refreshed.</strong>
              <ul style={{ margin: '8px 0' }}>
                {failedDataLoads.map(([key, state]) => <li key={key}>{state.error}</li>)}
              </ul>
              <button type="button" onClick={retryFailedDataLoads} disabled={isAnyDataLoading}>
                Retry failed data
              </button>
            </section>
          )}
          {activeTab === 'STUDENTS' ? renderStudentsView() : activeTab === 'CLASSES' ? renderClassesView() : activeTab === 'QUESTION_BANK' ? renderQuestionBankView() : activeTab === 'AI_IMPORTER' ? <ReviewedJsonImporter questionBank={questionBank} refreshQuestionBank={fetchQuestionBank} /> : activeTab === 'OPERATIONS' ? (
            <AdminOperationsView
              operationalHealth={operationalHealth}
              operationalLoading={operationalLoading}
              operationalError={operationalError}
              onRefresh={fetchOperationalOverview}
              unreferencedAssets={unreferencedAssets}
              scanningAssets={scanningAssets}
              cleaningAssets={cleaningAssets}
              onScanAssets={handleScanUnreferencedAssets}
              onCleanupAssets={handleCleanupUnreferencedAssets}
              auditEvents={auditEvents}
            />
          ) : activeTab === 'DB_CLEANER' ? (
            <AdminDatabaseCleanerView
              dbSize={dbSize}
              formatBytes={formatBytes}
              tableCounts={tableCounts}
              onMaintainTable={handleClearTable}
            />
          ) : activeExamId ? renderDetailView() : renderMasterView()}
        </div>
      </main>
    </div>
  );
};

export default AdminDashboard;
