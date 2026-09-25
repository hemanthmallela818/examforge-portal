import { useCallback, useEffect, useRef, useState } from 'react';
import { customAlert, customConfirm, showToast } from '../../../utils';
import { supabase } from '../../../supabase';
import { parsePagedCollectionResponse } from '../../../paginatedQuery';
import { normalizeQuestionBankRow } from '../../../questionBankPaging';
import { prepareQuestionDraft } from '../../../questionContentLogic';
import { useAdminContext } from '../adminContext';
import { QUESTION_BANK_PAGE_SIZE } from '../adminConstants';

/**
 * Question open in the editor: a bank row, or a blank draft (`docId: 'new'`).
 * @typedef {object} EditingQuestion
 * @property {string} docId
 * @property {string} [id]
 * @property {string} subject
 * @property {string} type
 * @property {string} text
 * @property {string[] | null} options
 * @property {string | number | null} correctAnswer
 * @property {string | null} questionImageUrl
 * @property {Array<string | null> | null} optionImageUrls
 * @property {boolean} [hasImageOrDiagram]
 */

/** @typedef {{ page: number, search: string, subject: string, type: string }} QuestionBankQuery */
/** @typedef {ReturnType<typeof useQuestionBank>} QuestionBankState */

/**
 * Server-paged Question Bank, cross-page question selection and the question
 * editor. Loads while `enabled` (Question Bank and Reviewed JSON Import tabs).
 * @param {{ enabled: boolean }} options
 */
export function useQuestionBank({ enabled }) {
  const { runAdminDataLoad, scheduleTableCounts, loadedCollections, catalog } = useAdminContext();
  const { activeSubjectNames } = catalog;

  const [questionBank, setQuestionBank] = useState(/** @type {import('../../../types').QuestionBankItem[]} */ ([]));
  // Subject of every question the admin has seen, so selections from earlier
  // pages can be counted per subject against the chosen pattern.
  const [knownQuestionSubjects, setKnownQuestionSubjects] = useState(/** @type {Record<string, string>} */ ({}));
  const [editingQuestion, setEditingQuestion] = useState(/** @type {EditingQuestion | null} */ (null));
  const [selectedQuestions, setSelectedQuestions] = useState(/** @type {string[]} */ ([]));
  const [questionSearchInput, setQuestionSearchInput] = useState('');
  const [questionSearch, setQuestionSearch] = useState('');
  const [questionSubjectFilter, setQuestionSubjectFilter] = useState('');
  const [questionTypeFilter, setQuestionTypeFilter] = useState('');
  const [questionBankPage, setQuestionBankPage] = useState(0);
  const [questionBankTotal, setQuestionBankTotal] = useState(0);
  const [questionBankSnapshot, setQuestionBankSnapshot] = useState(/** @type {QuestionBankQuery} */ ({ page: 0, search: '', subject: '', type: '' }));
  const questionBankQueryRef = useRef(/** @type {QuestionBankQuery} */ ({ page: 0, search: '', subject: '', type: '' }));

  useEffect(() => {
    questionBankQueryRef.current = {
      page: questionBankPage,
      search: questionSearch,
      subject: questionSubjectFilter,
      type: questionTypeFilter
    };
  }, [questionBankPage, questionSearch, questionSubjectFilter, questionTypeFilter]);

  const fetchQuestionBank = useCallback(async () => {
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
    const normalizedRows = data.rows.map(normalizeQuestionBankRow);
    setQuestionBank(normalizedRows);
    setKnownQuestionSubjects(prev => {
      const next = { ...prev };
      normalizedRows.forEach(row => { if (row.docId) next[row.docId] = row.subject; });
      return next;
    });
    setQuestionBankTotal(data.total);
    setQuestionBankSnapshot(query);
    const lastPage = Math.max(0, Math.ceil(data.total / QUESTION_BANK_PAGE_SIZE) - 1);
    if (data.page > lastPage) setQuestionBankPage(lastPage);
    loadedCollections.current.add('questions');
    scheduleTableCounts();
    return true;
  }, [runAdminDataLoad, scheduleTableCounts, loadedCollections]);

  useEffect(() => {
    if (!enabled) return;
    // This effect owns the server-side Question Bank query as well as the
    // initial load. A load-once guard here suppresses every later filter and
    // page request, leaving the old page visible and its controls disabled.
    fetchQuestionBank();
  }, [enabled, fetchQuestionBank, questionBankPage, questionSearch, questionSubjectFilter, questionTypeFilter]);

  /** @param {import('../../../types').UntrustedInput} editedQ Editor state (see prepareQuestionDraft). */
  const handleSaveQuestion = async (editedQ) => {
    // Active subjects, plus the question's existing subject if it was later deactivated
    // (the database applies the same rule).
    const allowedSubjects = [...activeSubjectNames, editingQuestion?.subject].filter(Boolean);
    const { question: normalizedQuestion, errors } = prepareQuestionDraft(editedQ, questionBank, { allowedSubjects });
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
      await customAlert(`Failed to save question: ${/** @type {Error} */ (err).message}`);
      return false;
    }
  };

  /** @param {string} docId */
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

  /** @param {'MCQ' | 'NUMERICAL'} [qType] */
  const handleAddBlankQuestion = (qType = 'MCQ') => {
    const isNumerical = qType === 'NUMERICAL';
    setEditingQuestion({
      docId: 'new',
      subject: activeSubjectNames[0] || '',
      type: isNumerical ? 'NUMERICAL' : 'MCQ',
      text: '',
      options: isNumerical ? [] : ['', '', '', ''],
      correctAnswer: isNumerical ? '' : 0,
      questionImageUrl: null,
      optionImageUrls: [null, null, null, null]
    });
  };

  return {
    questionBank,
    knownQuestionSubjects,
    fetchQuestionBank,
    editingQuestion,
    setEditingQuestion,
    selectedQuestions,
    setSelectedQuestions,
    questionSearchInput,
    setQuestionSearchInput,
    questionSearch,
    setQuestionSearch,
    questionSubjectFilter,
    setQuestionSubjectFilter,
    questionTypeFilter,
    setQuestionTypeFilter,
    questionBankPage,
    setQuestionBankPage,
    questionBankTotal,
    questionBankSnapshot,
    handleSaveQuestion,
    handleDeleteQuestion,
    handleAddBlankQuestion
  };
}
