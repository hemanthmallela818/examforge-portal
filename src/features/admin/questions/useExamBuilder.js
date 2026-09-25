import { useState } from 'react';
import { customAlert, showToast } from '../../../utils';
import { supabase } from '../../../supabase';
import { parseSelectedQuestionsResponse } from '../../../questionBankPaging';
import { prepareQuestionDraft } from '../../../questionContentLogic';
import { countBySubject, evaluatePatternSelection, orderExamSubjects, validateExamSettings } from '../../../examPatternLogic';
import { useAdminContext } from '../adminContext';
import { MAX_EXAM_QUESTIONS } from '../adminConstants';

/** @typedef {ReturnType<typeof useExamBuilder>} ExamBuilder */

/**
 * Builds the `cbt_exams` insert payload from server-verified questions. Shared
 * by the Create Exam card and the step-by-step wizard (its Review step runs the
 * preflight check on exactly this record before the same create path saves it).
 * @param {{
 *   title: string,
 *   targetClass: string,
 *   targetSection: string,
 *   duration: number | string,
 *   marksCorrect: number | string,
 *   marksIncorrect: number | string,
 *   template: import('../../../types').PatternTemplate | null,
 *   questions: import('../../../types').QuestionBankItem[],
 *   compareSubjects: ((a: string, b: string) => number) | null
 * }} input
 */
export function assembleExamRecord({ title, targetClass, targetSection, duration, marksCorrect, marksIncorrect, template, questions, compareSubjects }) {
  const subjects = orderExamSubjects(questions.map(q => q.subject), template, compareSubjects);
  /** @type {Record<string, import('../../../types').QuestionBankItem[]>} */
  const questionsObj = {};
  subjects.forEach(sub => {
    questionsObj[sub] = questions.filter(q => q.subject === sub);
  });

  return {
    title,
    status: 'PENDING',
    questions_data: {
      subjects,
      questions: questionsObj,
      totalQuestions: questions.length,
      duration: Number(duration),
      marksCorrect: Number(marksCorrect),
      marksIncorrect: Number(marksIncorrect),
      ...(template ? { pattern: { id: template.id, name: template.name } } : {})
    },
    class: targetClass,
    section: targetSection
  };
}

/**
 * "Create Exam" card state: title, target class/section, optional F1 exam
 * pattern, duration and marking. Assembles the exam from the selected
 * question IDs after server verification.
 * @param {{
 *   selectedQuestions: string[],
 *   setSelectedQuestions: import('react').Dispatch<import('react').SetStateAction<string[]>>,
 *   onExamCreated: () => void
 * }} options
 */
export function useExamBuilder({ selectedQuestions, setSelectedQuestions, onExamCreated }) {
  const { catalog } = useAdminContext();
  const { allSubjectNames, compareSubjects, usableTemplates } = catalog;

  const [newExamTitle, setNewExamTitle] = useState('');
  const [isCreatingExam, setIsCreatingExam] = useState(false);
  // Form inputs store strings; patterns and the defaults store numbers.
  const [examDuration, setExamDuration] = useState(/** @type {number | string} */ (180));
  const [examMarksCorrect, setExamMarksCorrect] = useState(/** @type {number | string} */ (4));
  const [examMarksIncorrect, setExamMarksIncorrect] = useState(/** @type {number | string} */ (-1));
  const [examTargetClass, setExamTargetClass] = useState('');
  const [examTargetSection, setExamTargetSection] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const selectedTemplate = usableTemplates.find(template => template.id === selectedTemplateId) || null;

  /** @param {string} templateId */
  const selectTemplate = (templateId) => {
    const template = usableTemplates.find(item => item.id === templateId);
    setSelectedTemplateId(template ? template.id : '');
    if (template) {
      setExamDuration(template.durationMinutes);
      setExamMarksCorrect(Number(template.marksCorrect));
      setExamMarksIncorrect(Number(template.marksIncorrect));
    }
  };

  /** @returns {Promise<boolean>} true once the exam has been saved. */
  const handleCreateExamFromSelected = async () => {
    if (isCreatingExam) return false;
    if (selectedQuestions.length === 0) {
      await customAlert("Please select at least one question.");
      return false;
    }
    if (selectedQuestions.length > MAX_EXAM_QUESTIONS) {
      await customAlert(`An exam can contain at most ${MAX_EXAM_QUESTIONS} questions. Remove ${selectedQuestions.length - MAX_EXAM_QUESTIONS} question(s) and try again.`);
      return false;
    }
    if (!newExamTitle.trim()) {
      await customAlert("Please enter an Exam Title first.");
      return false;
    }
    if (!examTargetClass || !examTargetSection) {
      await customAlert("Please select a target Class and Section for the exam.");
      return false;
    }
    const settingsProblems = validateExamSettings({ duration: examDuration, marksCorrect: examMarksCorrect, marksIncorrect: examMarksIncorrect });
    if (settingsProblems.length > 0) {
      await customAlert(settingsProblems.join('\n'));
      return false;
    }
    if (selectedTemplateId && !selectedTemplate) {
      await customAlert('The selected exam pattern is no longer available. Choose another pattern or "Custom".');
      return false;
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
      await customAlert(`The selected questions could not be verified: ${/** @type {Error} */ (error).message}`);
      setIsCreatingExam(false);
      return false;
    }
    const invalidSelectedQuestions = selectedQData
      // Existing questions may belong to a subject that was later deactivated; they stay usable.
      .map((question, index) => ({ number: index + 1, errors: prepareQuestionDraft(question, selectedQData, { allowedSubjects: allSubjectNames }).errors }))
      .filter(result => result.errors.length > 0);
    if (invalidSelectedQuestions.length > 0) {
      const summary = invalidSelectedQuestions.slice(0, 5)
        .map(result => `Question ${result.number}: ${result.errors.join(' ')}`)
        .join('\n');
      await customAlert(`The exam cannot be created until the selected questions are complete:\n\n${summary}`);
      setIsCreatingExam(false);
      return false;
    }

    if (selectedTemplate) {
      // Re-check against the server-verified questions, not only the on-screen counts.
      const check = evaluatePatternSelection(/** @type {import('../../../types').PatternTemplate} */ (selectedTemplate), countBySubject(selectedQData.map(q => q.subject)));
      if (!check.ok) {
        await customAlert(`The selected questions do not match the "${selectedTemplate.name}" pattern:\n\n• ${check.problems.join('\n• ')}`);
        setIsCreatingExam(false);
        return false;
      }
    }

    let created = false;
    const newExam = assembleExamRecord({
      title: newExamTitle,
      targetClass: examTargetClass,
      targetSection: examTargetSection,
      duration: examDuration,
      marksCorrect: examMarksCorrect,
      marksIncorrect: examMarksIncorrect,
      template: /** @type {import('../../../types').PatternTemplate | null} */ (selectedTemplate),
      questions: selectedQData,
      compareSubjects
    });

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
      setSelectedTemplateId('');
      onExamCreated();
      showToast("Exam created successfully!", "success");
      created = true;
    } catch (error) {
      console.error('Exam creation failed:', error);
      await customAlert(`The exam was not created: ${/** @type {Error} */ (error).message}`);
    } finally {
      setIsCreatingExam(false);
    }
    return created;
  };

  return {
    newExamTitle,
    setNewExamTitle,
    isCreatingExam,
    examDuration,
    setExamDuration,
    examMarksCorrect,
    setExamMarksCorrect,
    examMarksIncorrect,
    setExamMarksIncorrect,
    examTargetClass,
    setExamTargetClass,
    examTargetSection,
    setExamTargetSection,
    selectedTemplateId,
    selectedTemplate,
    usableTemplates,
    selectTemplate,
    handleCreateExamFromSelected
  };
}
