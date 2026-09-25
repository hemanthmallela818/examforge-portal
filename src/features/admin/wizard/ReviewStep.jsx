import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { Alert, Badge, Button, MetaList, cn } from '../../../components/ui';
import { supabase } from '../../../supabase';
import { parseSelectedQuestionsResponse } from '../../../questionBankPaging';
import { assembleExamRecord } from '../questions/useExamBuilder';
import { buildReviewChecks, summarizeSelection } from './wizardLogic';
import { SelectionSummary } from './QuestionsStep';
import PaperPreview from './PaperPreview';

/**
 * Loads the selected questions from the server (the same RPC the Create action
 * uses) so the checks and preview reflect exactly what will be saved.
 * @param {string[]} selectedQuestions
 */
function useVerifiedQuestions(selectedQuestions) {
  const key = selectedQuestions.join(',');
  const [state, setState] = useState(/** @type {{ key: string, questions: import('../../../types').QuestionBankItem[] | null, error: string }} */ ({ key: '', questions: null, error: '' }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const ids = key ? key.split(',') : [];
    if (ids.length === 0) return undefined;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_admin_questions_by_ids', { question_ids_param: ids });
        if (error) throw error;
        const questions = parseSelectedQuestionsResponse(data, ids);
        if (active) setState({ key, questions, error: '' });
      } catch (caught) {
        console.error('Selected questions could not be verified:', caught);
        if (active) setState({ key, questions: null, error: `The selected questions could not be verified: ${/** @type {Error} */ (caught).message}` });
      }
    })();
    return () => { active = false; };
  }, [key, attempt]);

  const current = state.key === key;
  return {
    questions: current ? state.questions : null,
    error: current ? state.error : '',
    loading: key !== '' && !current,
    retry: () => { setState(previous => ({ ...previous, key: '' })); setAttempt(value => value + 1); }
  };
}

/**
 * Step 4: summary, preflight-style checks and a read-only student preview.
 * @param {{
 *   examBuilder: import('../questions/useExamBuilder').ExamBuilder,
 *   selectedQuestions: string[],
 *   catalog: { allSubjectNames: string[], compareSubjects: (a: string, b: string) => number },
 *   onReadyChange: (ready: boolean) => void
 * }} props
 */
export default function ReviewStep({ examBuilder, selectedQuestions, catalog, onReadyChange }) {
  const {
    newExamTitle, examTargetClass, examTargetSection, examDuration, examMarksCorrect, examMarksIncorrect, selectedTemplate
  } = examBuilder;
  const template = /** @type {import('../../../types').PatternTemplate | null} */ (selectedTemplate);
  const verified = useVerifiedQuestions(selectedQuestions);
  const [showPreview, setShowPreview] = useState(false);

  const record = useMemo(() => (verified.questions ? assembleExamRecord({
    title: newExamTitle.trim(),
    targetClass: examTargetClass,
    targetSection: examTargetSection,
    duration: examDuration,
    marksCorrect: examMarksCorrect,
    marksIncorrect: examMarksIncorrect,
    template,
    questions: verified.questions,
    compareSubjects: catalog.compareSubjects
  }) : null), [verified.questions, newExamTitle, examTargetClass, examTargetSection, examDuration, examMarksCorrect, examMarksIncorrect, template, catalog.compareSubjects]);

  const { checks, ready } = buildReviewChecks({
    details: { title: newExamTitle, targetClass: examTargetClass, targetSection: examTargetSection },
    settings: { duration: examDuration, marksCorrect: examMarksCorrect, marksIncorrect: examMarksIncorrect },
    template,
    verifiedQuestions: verified.questions,
    verificationError: verified.error,
    record,
    knownSubjects: catalog.allSubjectNames
  });

  useEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);

  const subjectsById = Object.fromEntries((verified.questions || []).map(question => [question.docId, question.subject]));
  const summary = summarizeSelection({
    selectedIds: verified.questions ? selectedQuestions : [],
    subjectsById,
    marksCorrect: examMarksCorrect,
    template,
    compareSubjects: catalog.compareSubjects
  });
  const failed = checks.filter(check => !check.ok).length;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <MetaList
            items={[
              { label: 'Title', value: newExamTitle.trim() || '—' },
              { label: 'Class / section', value: examTargetClass ? `${examTargetClass} | Section ${examTargetSection || '—'}` : '—' },
              { label: 'Pattern', value: template ? template.name : 'Custom (no pattern)' },
              { label: 'Questions', value: <span className="tabular-nums">{selectedQuestions.length}</span> },
              { label: 'Duration', value: <span className="tabular-nums">{examDuration} min</span> },
              { label: 'Marking', value: <span className="tabular-nums">+{examMarksCorrect} / {examMarksIncorrect}</span> }
            ]}
          />

          <section aria-labelledby="wizard-checks-heading" className="rounded-xl border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
              <h4 id="wizard-checks-heading" className="text-sm font-semibold text-slate-900">Pre-flight checks</h4>
              {verified.loading
                ? <Badge variant="neutral"><Loader2 className="animate-spin" aria-hidden="true" /> Checking</Badge>
                : ready
                  ? <Badge variant="success"><CheckCircle2 aria-hidden="true" /> Ready to create</Badge>
                  : <Badge variant="danger"><XCircle aria-hidden="true" /> {failed} to fix</Badge>}
            </div>
            <ul className="flex flex-col divide-y divide-slate-100" aria-live="polite">
              {checks.map(check => {
                const pending = check.id === 'verified' && verified.loading;
                return (
                  <li key={check.id} className="flex gap-3 px-4 py-3">
                    {pending
                      ? <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-slate-400" aria-hidden="true" />
                      : check.ok
                        ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden="true" />
                        : <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden="true" />}
                    <div className="min-w-0 text-sm">
                      <p className={cn('font-medium', check.ok || pending ? 'text-slate-900' : 'text-red-800')}>
                        <span className="sr-only">{pending ? 'Checking: ' : check.ok ? 'Passed: ' : 'Failed: '}</span>{check.label}
                      </p>
                      {!check.ok && !pending && (check.details || []).length > 0 && (
                        <ul className="mt-1 list-disc pl-5 text-red-700">
                          {(check.details || []).map(detail => <li key={detail} className="break-words">{detail}</li>)}
                        </ul>
                      )}
                      {(check.warnings || []).length > 0 && (
                        <ul className="mt-1 flex flex-col gap-0.5 text-amber-800">
                          {(check.warnings || []).map(warning => (
                            <li key={warning} className="flex items-start gap-1.5 break-words"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {warning}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {verified.error && (
              <div className="border-t border-slate-100 px-4 py-3">
                <Button variant="secondary" size="sm" onClick={verified.retry}><RotateCcw aria-hidden="true" /> Check again</Button>
              </div>
            )}
          </section>
        </div>
        <SelectionSummary summary={summary} template={selectedTemplate} />
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <Button variant="secondary" onClick={() => setShowPreview(value => !value)} disabled={!record} aria-expanded={showPreview} aria-controls="wizard-preview-region">
            {showPreview ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />} {showPreview ? 'Hide student preview' : 'Preview as student'}
          </Button>
        </div>
        <div id="wizard-preview-region">
          {showPreview && record && <PaperPreview paper={record.questions_data} />}
        </div>
        {!ready && !verified.loading && (
          <Alert variant="neutral">Fix the failed checks above (use Back to change earlier steps) to enable Create exam.</Alert>
        )}
      </div>
    </div>
  );
}
