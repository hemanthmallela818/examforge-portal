import { useCallback, useEffect, useRef, useState } from 'react';
import { customAlert } from '../../../utils';
import { supabase } from '../../../supabase';
import { parseResultPageResponse } from '../../../resultPaging';
import { useAdminContext } from '../adminContext';
import { RESULT_PAGE_SIZE } from '../adminConstants';

/**
 * `public.cbt_exams` row plus the camel-cased `questionsData` alias.
 * @typedef {object} ExamDetailRecord
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string | null} class
 * @property {string | null} section
 * @property {string} [created_at]
 * @property {import('../../../types').UntrustedInput} questions_data Server-owned exam paper (jsonb).
 * @property {import('../../../types').UntrustedInput} questionsData Same object as `questions_data`.
 */

/**
 * Server payload of `get_admin_student_result_review` plus the row it was opened from.
 * @typedef {import('../../../types').UntrustedInput} StudentResultReview
 */

/** @typedef {{ examId: string | null, page: number, search: string }} ResultQuery */

/**
 * Full record, paged leaderboard and per-student answer review for the exam
 * selected in the route (`activeExamId`).
 * @param {{ activeExamId: string | null }} options
 */
export function useExamDetail({ activeExamId }) {
  const { runAdminDataLoad, scheduleTableCounts, loadedCollections } = useAdminContext();
  const [activeExamDetail, setActiveExamDetail] = useState(/** @type {ExamDetailRecord | null} */ (null));
  const [studentResults, setStudentResults] = useState(/** @type {import('../../../types').RankedResultRow[]} */ ([]));
  const [resultSearchInput, setResultSearchInput] = useState('');
  const [resultSearch, setResultSearch] = useState('');
  const [resultPage, setResultPage] = useState(0);
  const [resultPageTotal, setResultPageTotal] = useState(0);
  const [resultOverallCount, setResultOverallCount] = useState(0);
  const [resultSubjects, setResultSubjects] = useState(/** @type {string[]} */ ([]));
  const [resultAnalytics, setResultAnalytics] = useState(/** @type {import('../../../types').ResultPage['analytics']} */ (null));
  const [resultSnapshot, setResultSnapshot] = useState(/** @type {ResultQuery} */ ({ examId: null, page: 0, search: '' }));
  const [resultReview, setResultReview] = useState(/** @type {StudentResultReview | null} */ (null));
  const [resultReviewLoadingId, setResultReviewLoadingId] = useState(/** @type {unknown} */ (null));
  const activeExamIdRef = useRef(/** @type {string | null} */ (null));
  const resultQueryRef = useRef(/** @type {ResultQuery} */ ({ examId: null, page: 0, search: '' }));

  useEffect(() => {
    resultQueryRef.current = { examId: activeExamId, page: resultPage, search: resultSearch };
  }, [activeExamId, resultPage, resultSearch]);

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

  const fetchExamDetail = useCallback(async (/** @type {string} */ examId) => {
    const result = await runAdminDataLoad('examDetail', 'The selected examination details could not be loaded.', async () => {
      const { data, error } = await supabase.from('cbt_exams').select('*').eq('id', examId).single();
      if (error) throw error;
      return data;
    });
    if (!result.ok || !result.current) return result.ok;
    const data = result.data;
    if (activeExamIdRef.current === examId) setActiveExamDetail({ ...data, questionsData: data.questions_data });
    return true;
  }, [runAdminDataLoad]);

  const fetchResults = useCallback(async (/** @type {string | null} */ examId = activeExamIdRef.current) => {
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
  }, [runAdminDataLoad, scheduleTableCounts, loadedCollections]);

  // Opening an exam (or changing its leaderboard page/search) reloads both the
  // leaderboard page and the complete examination record.
  useEffect(() => {
    if (!activeExamId) return;
    Promise.all([fetchResults(activeExamId), fetchExamDetail(activeExamId)]).catch(error => {
      console.error('Exam detail loading failed:', error);
      customAlert('The complete exam details could not be loaded. Please check the connection and try again.');
    });
  }, [activeExamId, resultPage, resultSearch, fetchResults, fetchExamDetail]);

  /** @param {import('../../../types').RankedResultRow} result */
  const openStudentResultReview = async (result) => {
    setResultReviewLoadingId(result.id);
    try {
      const { data, error } = await supabase.rpc('get_admin_student_result_review', {
        result_id_param: result.id
      });
      if (error) throw error;
      setResultReview({ ...data, studentName: result.studentName, result });
    } catch (error) {
      console.error('Detailed result review failed:', error);
      await customAlert(/** @type {Error} */ (error).message || 'Detailed answer review could not be loaded.');
    } finally {
      setResultReviewLoadingId(null);
    }
  };

  /** Drops the selected exam and every loaded result (application reset). */
  const clearExamDetailState = useCallback(() => {
    activeExamIdRef.current = null;
    setActiveExamDetail(null);
    setStudentResults([]);
    setResultPageTotal(0);
    setResultOverallCount(0);
    setResultSubjects([]);
    setResultAnalytics(null);
  }, []);

  return {
    activeExamId,
    activeExamIdRef,
    activeExamDetail,
    setActiveExamDetail,
    studentResults,
    resultSearchInput,
    setResultSearchInput,
    resultSearch,
    setResultSearch,
    resultPage,
    setResultPage,
    resultPageTotal,
    resultOverallCount,
    resultSubjects,
    resultAnalytics,
    resultSnapshot,
    resultReview,
    setResultReview,
    resultReviewLoadingId,
    fetchExamDetail,
    fetchResults,
    openStudentResultReview,
    clearExamDetailState
  };
}
