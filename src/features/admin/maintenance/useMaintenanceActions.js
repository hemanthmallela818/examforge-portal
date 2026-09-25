import { useState } from 'react';
import { customAlert, customConfirm, showToast } from '../../../utils';
import { supabase } from '../../../supabase';
import { readFunctionInvocationError } from '../../../edgeFunctionErrors';
import { useAdminContext } from '../adminContext';

/**
 * Database Cleaner actions: root-only scoped clears and the application reset
 * (both through the audited DestructiveActionDialog), protected-record
 * messages and expired-attempt finalization.
 * @param {{
 *   fetchExams: () => Promise<unknown>,
 *   fetchResults: () => Promise<unknown>,
 *   fetchStudents: () => Promise<unknown>,
 *   fetchQuestionBank: () => Promise<unknown>,
 *   fetchOperationalOverview: () => Promise<unknown>,
 *   onApplicationReset: () => void
 * }} loaders
 */
export function useMaintenanceActions({
  fetchExams,
  fetchResults,
  fetchStudents,
  fetchQuestionBank,
  fetchOperationalOverview,
  onApplicationReset
}) {
  const {
    isRootDeveloper,
    tableCounts,
    fetchTableCounts,
    loadedCollections,
    classBook,
    setDestructiveAction
  } = useAdminContext();
  const { fetchClasses } = classBook;
  const [isResettingApplication, setIsResettingApplication] = useState(false);

  /**
   * @param {string} tableName
   * @param {string} tableDisplayName
   */
  const handleRootScopedClear = async (tableName, tableDisplayName) => {
    if (!isRootDeveloper) {
      await customAlert('Only the root developer can clear this data. Student accounts remain protected.');
      return;
    }
    const cleanup = /** @type {Record<string, { confirmation: string, warning: string, preserved: string[] } | undefined>} */ ({
      student_results: {
        confirmation: 'CLEAR EXAM RESULTS',
        warning: 'Download or export the exam results before continuing. This clears submitted results only.',
        preserved: ['students', 'exams', 'classes', 'question bank', 'root and administrator accounts']
      },
      cbt_exams: {
        confirmation: 'CLEAR EXAMS',
        warning: 'This clears all exam schedules and exam snapshots. Results and active sessions must already be cleared, otherwise the server refuses.',
        preserved: ['students', 'classes', 'question bank', 'root and administrator accounts']
      },
      question_bank: {
        confirmation: 'CLEAR QUESTION BANK',
        warning: 'This clears reusable question-bank records only.',
        preserved: ['existing exam snapshots', 'image assets', 'students', 'results']
      }
    })[tableName];
    if (!cleanup) return;
    setDestructiveAction({
      title: `Clear ${tableDisplayName}`,
      description: cleanup.warning,
      impact: [{ label: tableDisplayName, count: tableCounts[/** @type {keyof import('../../../types').TableCounts} */ (tableName)] ?? Number.NaN }],
      preserved: cleanup.preserved,
      phrase: cleanup.confirmation,
      confirmLabel: `Clear ${tableDisplayName}`,
      run: async (confirmation) => {
        const { data, error } = await supabase.functions.invoke('manage-student', {
          body: { action: 'clear-scoped-data', target: tableName, confirmation }
        });
        if (error || data?.cleared !== true) {
          throw new Error(await readFunctionInvocationError({ data, error }, `${tableDisplayName} cleanup failed`));
        }
        await Promise.all([
          fetchTableCounts(),
          tableName === 'student_results' ? fetchResults() : Promise.resolve(),
          tableName === 'cbt_exams' ? fetchExams() : Promise.resolve(),
          tableName === 'question_bank' ? fetchQuestionBank() : Promise.resolve()
        ]);
        const deleted = Number.isFinite(data?.deleted) ? `${data.deleted} row(s) removed. ` : '';
        showToast(`${tableDisplayName} cleared. Student accounts were preserved.`, 'success');
        return `${tableDisplayName} cleared. ${deleted}Student accounts were preserved and the action was recorded in the audit log.`;
      }
    });
  };

  // Clearing the whole bank is root-only (PRD 2.4); reuse the audited root cleanup dialog.
  const handleDeleteAllQuestions = () => handleRootScopedClear('question_bank', 'Question Bank');

  /**
   * @param {string} tableName
   * @param {string} tableDisplayName
   */
  const handleClearTable = async (tableName, tableDisplayName) => {
    if (['student_results', 'cbt_exams', 'question_bank'].includes(tableName)) {
      await handleRootScopedClear(tableName, tableDisplayName);
      return;
    }
    if (['student_results', 'cbt_exams', 'students', 'classes', 'import_history'].includes(tableName)) {
      /** @type {Record<string, string>} */
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
        await customAlert(`Expired-attempt finalization failed: ${/** @type {Error} */ (err).message}`);
      }
      return;
    }
    await customAlert(`No cleanup operation is available for ${tableDisplayName}.`);
  };

  const handleResetApplicationData = async () => {
    if (!isRootDeveloper || isResettingApplication) return;
    setIsResettingApplication(true);
    try {
      const previewResult = await supabase.functions.invoke('manage-student', {
        body: { action: 'preview-reset' }
      });
      if (previewResult.error || !previewResult.data?.preview) {
        throw new Error(await readFunctionInvocationError(previewResult, 'Reset preview failed'));
      }
      const preview = previewResult.data.preview;
      const count = (/** @type {unknown} */ value) => Number(value) || 0;
      setDestructiveAction({
        title: 'Reset application data',
        description: 'This operation cannot be undone. All academic data below is permanently removed so the installation can be reused.',
        impact: [
          { label: 'Student sign-in accounts', count: count(preview.student_accounts) },
          { label: 'Results', count: count(preview.results) },
          { label: 'Exams', count: count(preview.exams) },
          { label: 'Active sessions', count: count(preview.active_sessions) },
          { label: 'Reusable questions', count: count(preview.questions) },
          { label: 'Classes', count: count(preview.classes) },
          { label: 'Import-history rows', count: count(preview.import_history) },
          { label: 'Previous audit events', count: count(preview.audit_events) }
        ],
        preserved: ['your root account', 'managed administrator accounts', 'private Storage files'],
        phrase: 'RESET APPLICATION DATA',
        confirmLabel: 'Reset application data',
        run: async (confirmation) => {
          setIsResettingApplication(true);
          try {
            const resetResult = await supabase.functions.invoke('manage-student', {
              body: { action: 'reset-application', confirmation }
            });
            if (resetResult.error || resetResult.data?.reset !== true) {
              throw new Error(await readFunctionInvocationError(resetResult, 'Application reset failed'));
            }

            onApplicationReset();
            loadedCollections.current.clear();
            await Promise.all([
              fetchTableCounts(),
              fetchExams(),
              fetchStudents(),
              fetchQuestionBank(),
              fetchClasses(),
              fetchOperationalOverview()
            ]);
            const removed = resetResult.data.deletedAuthUsers || 0;
            showToast(`Application data reset completed. ${removed} student sign-in account(s) removed.`, 'success');
            return `Application data reset completed. ${removed} student sign-in account(s) removed. Root and administrator accounts were preserved.`;
          } catch (error) {
            console.error('Application reset failed:', error);
            throw error;
          } finally {
            setIsResettingApplication(false);
          }
        }
      });
    } catch (error) {
      console.error('Application reset preview failed:', error);
      await customAlert(`Application reset failed: ${/** @type {Error} */ (error).message}`);
    } finally {
      setIsResettingApplication(false);
    }
  };

  return {
    isResettingApplication,
    handleRootScopedClear,
    handleDeleteAllQuestions,
    handleClearTable,
    handleResetApplicationData
  };
}
