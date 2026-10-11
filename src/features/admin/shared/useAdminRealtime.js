import { useEffect, useEffectEvent, useRef } from 'react';
import { showToast } from '../../../utils';
import { supabase } from '../../../supabase';

/**
 * @typedef {object} AdminRealtimeServices
 * @property {{ exams: boolean, students: boolean, questions: boolean, classes: boolean }} visibleCollections
 * @property {() => unknown} fetchTableCounts
 * @property {() => void} scheduleTableCounts
 * @property {() => Promise<unknown>} fetchExams
 * @property {(examId: string) => Promise<unknown>} fetchExamDetail
 * @property {(examId: string) => unknown} fetchResults
 * @property {import('react').RefObject<string | null>} activeExamIdRef
 * @property {() => unknown} fetchStudents
 * @property {import('react').RefObject<Array<{ docId: string, name: string }>>} studentsListRef
 * @property {import('react').RefObject<Set<string>>} locallyAddedStudents
 * @property {() => unknown} fetchQuestionBank
 * @property {() => unknown} fetchClasses
 */

/**
 * Realtime `postgres_changes` payload. Rows come from the server and are
 * treated as untrusted.
 * @typedef {{ eventType?: string, new?: import('../../../types').UntrustedInput, old?: import('../../../types').UntrustedInput }} RealtimePayload
 */

/**
 * Supabase Realtime subscriptions for the administrator workspace. Channels
 * are opened once when the workspace mounts (after access is granted) and
 * closed on unmount; the handlers are effect events, so they always see the
 * current loaders without re-subscribing. Refreshes are debounced per
 * collection and only target collections used by the current screen.
 * @param {AdminRealtimeServices} services
 */
export function useAdminRealtime({
  visibleCollections,
  fetchTableCounts,
  scheduleTableCounts,
  fetchExams,
  fetchExamDetail,
  fetchResults,
  activeExamIdRef,
  fetchStudents,
  studentsListRef,
  locallyAddedStudents,
  fetchQuestionBank,
  fetchClasses
}) {
  const collectionRefreshTimers = useRef(/** @type {Map<string, ReturnType<typeof setTimeout>>} */ (new Map()));
  const pendingAdded = useRef(/** @type {string[]} */ ([]));
  const pendingDeleted = useRef(/** @type {string[]} */ ([]));
  const debounceTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const visibleCollectionsRef = useRef(visibleCollections);
  useEffect(() => { visibleCollectionsRef.current = visibleCollections; }, [visibleCollections]);

  /**
   * @param {'exams' | 'examDetail' | 'results' | 'students' | 'questions' | 'classes'} key
   * @param {() => unknown} refresh
   */
  const scheduleCollectionRefresh = (key, refresh) => {
    const existing = collectionRefreshTimers.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      collectionRefreshTimers.current.delete(key);
      const visible = key === 'examDetail' || key === 'results'
        ? Boolean(activeExamIdRef.current)
        : visibleCollectionsRef.current[key];
      if (visible) refresh();
    }, 300);
    collectionRefreshTimers.current.set(key, timer);
  };

  const loadInitialCounts = useEffectEvent(() => {
    fetchTableCounts();
  });

  const handleExamStatusChange = useEffectEvent(() => {
    if (visibleCollections.exams) scheduleCollectionRefresh('exams', fetchExams);
    const currentExamId = activeExamIdRef.current;
    if (currentExamId) {
      scheduleCollectionRefresh('examDetail', () => {
        if (activeExamIdRef.current === currentExamId) return fetchExamDetail(currentExamId);
      });
    } else if (!visibleCollections.exams) {
      scheduleTableCounts();
    }
  });

  const handleResultChange = useEffectEvent((/** @type {RealtimePayload} */ payload) => {
    const currentExamId = activeExamIdRef.current;
    const result = payload.new || payload.old;
    if (currentExamId && result?.exam_id === currentExamId) {
      scheduleCollectionRefresh('results', () => {
        if (activeExamIdRef.current === currentExamId) return fetchResults(currentExamId);
      });
    } else {
      scheduleTableCounts();
    }
  });

  const handleStudentChange = useEffectEvent((/** @type {RealtimePayload} */ payload) => {
    // Fetch fresh list
    if (visibleCollections.students) {
      scheduleCollectionRefresh('students', fetchStudents);
    } else {
      scheduleTableCounts();
    }

    // Accumulate details for notifications
    if (payload.eventType === 'INSERT') {
      const insertId = (payload.new.student_id || '').toLowerCase();
      const insertName = (payload.new.name || '').toLowerCase();
      if (locallyAddedStudents.current.has(insertId) || locallyAddedStudents.current.has(insertName)) {
        locallyAddedStudents.current.delete(insertId);
        locallyAddedStudents.current.delete(insertName);
      } else {
        pendingAdded.current.push(payload.new.name || payload.new.student_id);
      }
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
  });

  const handleQuestionBankChange = useEffectEvent(() => {
    if (visibleCollections.questions) scheduleCollectionRefresh('questions', fetchQuestionBank);
    else scheduleTableCounts();
  });

  const handleClassChange = useEffectEvent(() => {
    if (visibleCollections.classes) scheduleCollectionRefresh('classes', fetchClasses);
    else scheduleTableCounts();
  });

  useEffect(() => {
    const refreshTimers = collectionRefreshTimers.current;
    // The overview needs only exams and aggregate counts. Large collections
    // are loaded when their owning screen is opened.
    loadInitialCounts();

    // Supabase Realtime subscriptions
    const examsChannel = supabase
      .channel('admin-exams')
      // Raw papers never enter Realtime; this table contains metadata only.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exam_status_events' }, () => handleExamStatusChange())
      .subscribe();

    const resultsChannel = supabase
      .channel('admin-results')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'student_results' }, (payload) => handleResultChange(payload))
      .subscribe();

    const studentsChannel = supabase
      .channel('admin-students')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, (payload) => handleStudentChange(payload))
      .subscribe();

    const qbChannel = supabase
      .channel('admin-qb')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'question_bank' }, () => handleQuestionBankChange())
      .subscribe();

    const classesChannel = supabase
      .channel('admin-classes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, () => handleClassChange())
      .subscribe();

    return () => {
      refreshTimers.forEach(timer => clearTimeout(timer));
      refreshTimers.clear();
      supabase.removeChannel(examsChannel);
      supabase.removeChannel(resultsChannel);
      supabase.removeChannel(studentsChannel);
      supabase.removeChannel(qbChannel);
      supabase.removeChannel(classesChannel);
    };
  }, []);
}
