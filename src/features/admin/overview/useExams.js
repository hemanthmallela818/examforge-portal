import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../supabase';
import { parsePagedCollectionResponse } from '../../../paginatedQuery';
import { normalizeExamListRow } from '../../../examListPaging';
import { useAdminContext } from '../adminContext';
import { EXAM_LIST_PAGE_SIZE } from '../adminConstants';

/**
 * Server-paged examination list shown on the Dashboard overview. Loads while `enabled`.
 * @param {{ enabled: boolean }} options
 */
export function useExams({ enabled }) {
  const { runAdminDataLoad, scheduleTableCounts, loadedCollections } = useAdminContext();
  const [exams, setExams] = useState(/** @type {import('../../../types').ExamListItem[]} */ ([]));
  const [examSearchInput, setExamSearchInput] = useState('');
  const [examSearch, setExamSearch] = useState('');
  const [examStatusFilter, setExamStatusFilter] = useState('');
  const [examListPage, setExamListPage] = useState(0);
  const [examListTotal, setExamListTotal] = useState(0);
  const [examListSnapshot, setExamListSnapshot] = useState({ page: 0, search: '', status: '' });
  const examListQueryRef = useRef({ page: 0, search: '', status: '' });

  useEffect(() => {
    examListQueryRef.current = { page: examListPage, search: examSearch, status: examStatusFilter };
  }, [examListPage, examSearch, examStatusFilter]);

  // Identical requests that overlap (React StrictMode's double effect run, or a
  // realtime refresh arriving while the page loads) share one network call.
  const inFlightExamLoad = useRef(/** @type {{ key: string, promise: Promise<boolean> } | null} */ (null));

  const loadExamPage = useCallback(async (/** @type {{ page: number, search: string, status: string }} */ query) => {
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
  }, [runAdminDataLoad, scheduleTableCounts, loadedCollections]);

  const fetchExams = useCallback(() => {
    const query = { ...examListQueryRef.current };
    const key = JSON.stringify(query);
    const pending = inFlightExamLoad.current;
    if (pending && pending.key === key) return pending.promise;
    const promise = loadExamPage(query).finally(() => {
      if (inFlightExamLoad.current?.promise === promise) inFlightExamLoad.current = null;
    });
    inFlightExamLoad.current = { key, promise };
    return promise;
  }, [loadExamPage]);

  // The overview (re)loads its page whenever it is opened or its query changes.
  useEffect(() => {
    if (!enabled) return;
    fetchExams();
  }, [enabled, fetchExams, examListPage, examSearch, examStatusFilter]);

  /** Clears search, status filter and paging (after a new exam is created). */
  const resetExamListQuery = useCallback(() => {
    setExamSearchInput('');
    setExamSearch('');
    setExamStatusFilter('');
    setExamListPage(0);
  }, []);

  return {
    exams,
    fetchExams,
    examSearchInput,
    setExamSearchInput,
    examSearch,
    setExamSearch,
    examStatusFilter,
    setExamStatusFilter,
    examListPage,
    setExamListPage,
    examListTotal,
    examListSnapshot,
    resetExamListQuery
  };
}
