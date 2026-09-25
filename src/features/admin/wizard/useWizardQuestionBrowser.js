import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../supabase';
import { parsePagedCollectionResponse } from '../../../paginatedQuery';
import { normalizeQuestionBankRow } from '../../../questionBankPaging';

export const WIZARD_QUESTION_PAGE_SIZE = 25;

/** @typedef {{ page: number, search: string, subject: string, type: string }} BrowserQuery */

/**
 * Server-paged Question Bank browser for the wizard's Questions step. Keeps its
 * own query and loading state so it never disturbs the Question Bank screen's
 * list (the wizard can be opened on top of it).
 * @param {{ enabled: boolean, onRowsLoaded?: (rows: import('../../../types').QuestionBankItem[]) => void }} options
 */
export function useWizardQuestionBrowser({ enabled, onRowsLoaded }) {
  const [rows, setRows] = useState(/** @type {import('../../../types').QuestionBankItem[]} */ ([]));
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState(/** @type {BrowserQuery} */ ({ page: 0, search: '', subject: '', type: '' }));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);
  const onRowsLoadedRef = useRef(onRowsLoaded);
  useEffect(() => { onRowsLoadedRef.current = onRowsLoaded; }, [onRowsLoaded]);

  const load = useCallback(async (/** @type {BrowserQuery} */ current) => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_admin_question_bank_page', {
        page_number_param: current.page,
        page_size_param: WIZARD_QUESTION_PAGE_SIZE,
        search_param: current.search || null,
        subject_param: current.subject || null,
        type_param: current.type || null
      });
      if (rpcError) throw rpcError;
      const page = parsePagedCollectionResponse(data, { expectedPage: current.page, expectedPageSize: WIZARD_QUESTION_PAGE_SIZE });
      if (request !== requestRef.current) return;
      const normalized = page.rows.map(normalizeQuestionBankRow);
      setRows(normalized);
      setTotal(page.total);
      setError('');
      onRowsLoadedRef.current?.(normalized);
      const lastPage = Math.max(0, Math.ceil(page.total / WIZARD_QUESTION_PAGE_SIZE) - 1);
      if (current.page > lastPage) setQuery(previous => ({ ...previous, page: lastPage }));
    } catch (caught) {
      console.error('Wizard question page could not be loaded:', caught);
      if (request === requestRef.current) setError('Questions could not be loaded. Check the connection and retry.');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load(query);
  }, [enabled, load, query]);

  useEffect(() => () => { requestRef.current += 1; }, []);

  const totalPages = Math.max(1, Math.ceil(total / WIZARD_QUESTION_PAGE_SIZE));

  return {
    rows,
    total,
    totalPages,
    loading,
    error,
    query,
    searchInput,
    setSearchInput,
    applySearch: () => setQuery(previous => ({ ...previous, page: 0, search: searchInput.trim() })),
    clearSearch: () => {
      setSearchInput('');
      setQuery(previous => ({ ...previous, page: 0, search: '' }));
    },
    setSubject: (/** @type {string} */ subject) => setQuery(previous => ({ ...previous, page: 0, subject })),
    setType: (/** @type {string} */ type) => setQuery(previous => ({ ...previous, page: 0, type })),
    setPage: (/** @type {number} */ page) => setQuery(previous => ({ ...previous, page: Math.min(Math.max(0, page), totalPages - 1) })),
    retry: () => load(query)
  };
}
