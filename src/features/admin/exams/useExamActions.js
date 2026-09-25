import { customAlert, customConfirm, customPrompt, showToast } from '../../../utils';
import { supabase } from '../../../supabase';

/**
 * Exam lifecycle actions shared by the overview cards and the exam detail:
 * preflight validation, start/end and deletion of unused exams.
 * @param {{
 *   examList: ReturnType<typeof import('../overview/useExams').useExams>,
 *   examDetail: ReturnType<typeof import('./useExamDetail').useExamDetail>,
 *   onExamDeleted: () => void
 * }} dependencies
 */
export function useExamActions({ examList, examDetail, onExamDeleted }) {
  const { exams, fetchExams } = examList;
  const { activeExamId, activeExamDetail, setActiveExamDetail, studentResults, fetchExamDetail } = examDetail;

  /** @param {string} examId */
  const handlePreflightCheck = async (examId) => {
    try {
      const { data, error } = await supabase.rpc('preflight_validate_exam', { exam_id_param: examId });
      if (error) throw error;
      if (data.valid) {
        await customAlert(`Preflight Check Passed!\n\nTotal Questions: ${data.totalQuestions}\nVerified Storage Assets: ${data.verifiedAssets}\nWarnings: ${data.warnings?.length || 0}`);
        return true;
      } else {
        const errorList = (data.errors || []).slice(0, 8).join('\n• ');
        await customAlert(`Preflight Check Failed (${data.errors?.length || 0} errors):\n\n• ${errorList}\n\nResolve these issues before activating the exam.`);
        return false;
      }
    } catch (err) {
      console.error('Preflight check RPC error:', err);
      await customAlert(`Preflight check failed: ${/** @type {Error} */ (err).message}`);
      return false;
    }
  };

  /** @param {string} examId */
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

  /** @param {string} examId */
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
          onExamDeleted();
          setActiveExamDetail(null);
        }
        showToast("Exam deleted successfully.", "success");
        await fetchExams();
      } catch (err) {
        console.error("Failed to delete exam:", err);
        await customAlert("Failed to delete exam: " + /** @type {Error} */ (err).message);
      }
    }
  };

  return { handlePreflightCheck, toggleExamStatus, handleDeleteExam };
}
