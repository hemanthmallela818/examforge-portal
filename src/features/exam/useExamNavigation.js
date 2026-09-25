// Answer selection and question/subject navigation for the active exam.
// Every handler is memoized so the memoized QuestionPanel and GridPanel only
// re-render when the data they display actually changes.
import { useCallback } from 'react';
import { announcePolite } from '../../components/LiveAnnouncer';

/**
 * @typedef {import('../../types').ExamResponses} ExamResponses
 * @typedef {import('../../types').ResponseStatus} ResponseStatus
 * @typedef {import('../../types').SelectedOption} SelectedOption
 * @typedef {'SAVE_NEXT' | 'SAVE_MARK' | 'MARK_NEXT'} ExamActionType
 */

/**
 * @param {{
 *   examData: import('../../types').ExamPaper,
 *   activeSubject: string,
 *   setActiveSubject: (subject: string) => void,
 *   currentIndices: import('../../types').CurrentIndices,
 *   setCurrentIndices: import('react').Dispatch<import('react').SetStateAction<import('../../types').CurrentIndices>>,
 *   userResponses: ExamResponses,
 *   setUserResponses: import('react').Dispatch<import('react').SetStateAction<ExamResponses>>,
 *   offlineSince: number | null,
 *   setAutosaveStatus: (status: 'SAVING' | 'OFFLINE') => void,
 *   studentSessionLockedRef: { current: boolean }
 * }} options
 */
export function useExamNavigation({
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
}) {
  const updateResponse = useCallback((/** @type {number} */ index, /** @type {SelectedOption} */ selectedOption, /** @type {ResponseStatus} */ status) => {
    if (studentSessionLockedRef.current) return;
    setAutosaveStatus(navigator.onLine && !offlineSince ? 'SAVING' : 'OFFLINE');
    setUserResponses(prev => {
      if (!prev[activeSubject]) return prev;
      const newResponses = { ...prev };
      newResponses[activeSubject] = [...newResponses[activeSubject]];
      newResponses[activeSubject][index] = { selectedOption, status };
      return newResponses;
    });
  }, [activeSubject, offlineSince, setAutosaveStatus, setUserResponses, studentSessionLockedRef]);

  const selectResponse = useCallback((/** @type {number} */ index, /** @type {SelectedOption} */ selectedOption) => {
    if (studentSessionLockedRef.current) return;
    setAutosaveStatus(navigator.onLine && !offlineSince ? 'SAVING' : 'OFFLINE');
    setUserResponses(prev => {
      if (!prev[activeSubject] || !prev[activeSubject][index]) return prev;
      const currentResponse = prev[activeSubject][index];
      /** @type {ResponseStatus} */
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
  }, [activeSubject, offlineSince, setAutosaveStatus, setUserResponses, studentSessionLockedRef]);

  const changeSubjectAndIndex = useCallback((/** @type {string} */ newSubject, /** @type {number} */ newIndex) => {
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
  }, [setActiveSubject, setCurrentIndices, setUserResponses]);

  const changeQuestion = useCallback((/** @type {number} */ newIndex) => {
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
  }, [activeSubject, setCurrentIndices, setUserResponses]);

  const goNext = useCallback(() => {
    const currentIndex = currentIndices[activeSubject] || 0;
    const subQuestions = examData?.questions?.[activeSubject] || [];
    if (currentIndex < subQuestions.length - 1) {
      changeQuestion(currentIndex + 1);
    } else {
      const subjectIndex = examData?.subjects ? examData.subjects.indexOf(activeSubject) : -1;
      if (subjectIndex >= 0 && subjectIndex < (examData?.subjects?.length || 0) - 1) {
        changeSubjectAndIndex(/** @type {string[]} */ (examData.subjects)[subjectIndex + 1], 0);
      }
    }
  }, [activeSubject, changeQuestion, changeSubjectAndIndex, currentIndices, examData]);

  const goPrev = useCallback(() => {
    const currentIndex = currentIndices[activeSubject] || 0;
    if (currentIndex > 0) {
      changeQuestion(currentIndex - 1);
    } else {
      const subjectIndex = examData?.subjects ? examData.subjects.indexOf(activeSubject) : -1;
      if (subjectIndex > 0) {
        const prevSubject = /** @type {string[]} */ (examData.subjects)[subjectIndex - 1];
        const prevSubQuestions = examData?.questions?.[prevSubject] || [];
        const lastIndex = Math.max(0, prevSubQuestions.length - 1);
        changeSubjectAndIndex(prevSubject, lastIndex);
      }
    }
  }, [activeSubject, changeQuestion, changeSubjectAndIndex, currentIndices, examData]);

  const handleAction = useCallback((/** @type {ExamActionType} */ actionType) => {
    if (studentSessionLockedRef.current) return;
    const currentIndex = currentIndices[activeSubject] || 0;
    const currentResponse = userResponses?.[activeSubject]?.[currentIndex] || { selectedOption: null, status: /** @type {ResponseStatus} */ ('NOT_VISITED') };

    /** @type {ResponseStatus} */
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
  }, [activeSubject, currentIndices, goNext, studentSessionLockedRef, updateResponse, userResponses]);

  const handleSubjectChange = useCallback((/** @type {string} */ sub) => {
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
  }, [currentIndices, setActiveSubject, setUserResponses]);

  return {
    selectResponse,
    handleAction,
    goNext,
    goPrev,
    changeQuestion,
    handleSubjectChange
  };
}
