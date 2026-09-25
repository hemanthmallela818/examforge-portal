import { AlertTriangle, CheckCircle2, Library, Search } from 'lucide-react';
import { Alert, Badge, Button, Checkbox, EmptyState, Field, Input, LoadingBlock, Select, cn } from '../../../components/ui';
import MathRenderer from '../../../components/MathRenderer';
import { MAX_EXAM_QUESTIONS } from '../adminConstants';
import { PagerButtons, pagerNavClass } from '../shared/AdminUi';
import { WIZARD_QUESTION_PAGE_SIZE } from './useWizardQuestionBrowser';

const formatMarks = (/** @type {number | null} */ value) => (value === null ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 }));

/**
 * Per-subject live counts and marks for the current selection (and the pattern check).
 * @param {{ summary: ReturnType<typeof import('./wizardLogic').summarizeSelection>, template: import('../../../types').ExamTemplateEntry | null }} props
 */
export function SelectionSummary({ summary, template }) {
  const { rows, patternCheck, totalQuestions, totalMarks } = summary;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3" aria-live="polite">
      <p className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        <span>{template ? 'Pattern check' : 'Selection'}</span>
        {patternCheck && (patternCheck.ok
          ? <Badge variant="success"><CheckCircle2 aria-hidden="true" /> Matches</Badge>
          : <Badge variant="warning"><AlertTriangle aria-hidden="true" /> Not yet</Badge>)}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No questions selected yet.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Selected questions and marks by subject</caption>
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th scope="col" className="pb-1 font-medium">Subject</th>
              <th scope="col" className="pb-1 text-right font-medium">Questions</th>
              <th scope="col" className="pb-1 text-right font-medium">Marks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.subject}>
                <th scope="row" className={cn('py-0.5 text-left font-normal', row.status === 'extra' ? 'text-red-700' : 'text-slate-700')}>
                  {row.subject}{row.status === 'extra' && ' (not in pattern)'}
                </th>
                <td className={cn('py-0.5 text-right font-semibold tabular-nums',
                  row.status === 'ok' ? 'text-emerald-700' : row.status === 'short' ? 'text-amber-700' : row.status ? 'text-red-700' : 'text-slate-900')}>
                  {row.required === null ? row.count : `${row.count} / ${row.required}`}
                </td>
                <td className="py-0.5 text-right tabular-nums text-slate-600">{formatMarks(row.marks)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200">
              <th scope="row" className="pt-1.5 text-left font-semibold text-slate-900">Total</th>
              <td className="pt-1.5 text-right font-semibold text-slate-900 tabular-nums">
                {template ? `${totalQuestions} / ${template.totalQuestions}` : totalQuestions}
              </td>
              <td className="pt-1.5 text-right font-semibold text-slate-900 tabular-nums">{formatMarks(totalMarks)}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

/**
 * Step 2: choose a pattern and pick questions from the Question Bank.
 * @param {{
 *   examBuilder: import('../questions/useExamBuilder').ExamBuilder,
 *   selectedQuestions: string[],
 *   setSelectedQuestions: import('react').Dispatch<import('react').SetStateAction<string[]>>,
 *   browser: ReturnType<typeof import('./useWizardQuestionBrowser').useWizardQuestionBrowser>,
 *   summary: ReturnType<typeof import('./wizardLogic').summarizeSelection>,
 *   subjectCatalog: import('../../../types').SubjectCatalogEntry[],
 *   problems: string[],
 *   showErrors: boolean
 * }} props
 */
export default function QuestionsStep({ examBuilder, selectedQuestions, setSelectedQuestions, browser, summary, subjectCatalog, problems, showErrors }) {
  const { selectedTemplate, selectedTemplateId, usableTemplates, selectTemplate } = examBuilder;
  const { rows, total, totalPages, loading, error, query, searchInput, setSearchInput, applySearch, clearSearch, setSubject, setType, setPage, retry } = browser;
  const pageIds = rows.map(row => row.docId);
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedQuestions.includes(id));
  const firstRow = total === 0 ? 0 : (query.page * WIZARD_QUESTION_PAGE_SIZE) + 1;
  const lastRow = total === 0 ? 0 : Math.min(total, firstRow + rows.length - 1);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-4 lg:order-2">
        <Field
          label="Exam pattern"
          htmlFor="wizard-exam-pattern"
          hint={selectedTemplate ? 'The pattern sets the questions per subject, the duration and the marking.' : 'Optional. A pattern checks the selection and fills in timing and marking.'}
        >
          <Select id="wizard-exam-pattern" value={selectedTemplate ? selectedTemplateId : ''} onChange={event => selectTemplate(event.target.value)}>
            <option value="">Custom (no pattern)</option>
            {usableTemplates.map(template => (
              <option key={template.id} value={template.id}>
                {template.name} · {template.totalQuestions} Qs · {template.durationMinutes} min
              </option>
            ))}
          </Select>
        </Field>
        <SelectionSummary summary={summary} template={selectedTemplate} />
        <p className="text-sm text-slate-600">
          Selected <strong className="text-slate-900 tabular-nums">{selectedQuestions.length}</strong> / {MAX_EXAM_QUESTIONS} questions
        </p>
        {selectedQuestions.length > 0 && (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setSelectedQuestions([])}>Clear selection</Button>
        )}
        {showErrors && problems.length > 0 && (
          <Alert variant="warning" role="alert" id="wizard-questions-problems">
            <ul className="flex flex-col gap-0.5">
              {problems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          </Alert>
        )}
      </div>

      <section aria-label="Question Bank" className="flex min-w-0 flex-col gap-3 lg:order-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input
              type="search"
              aria-label="Search the Question Bank"
              placeholder="Question number, text, or subject"
              maxLength={100}
              value={searchInput}
              onChange={event => setSearchInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applySearch(); } }}
              className="pl-9"
            />
          </div>
          <Button variant="secondary" onClick={applySearch}>Search</Button>
          {(query.search || searchInput) && <Button variant="ghost" onClick={clearSearch}>Clear search</Button>}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select aria-label="Show questions from subject" value={query.subject} onChange={event => setSubject(event.target.value)}>
            <option value="">All subjects</option>
            {subjectCatalog.map(subject => (
              <option key={subject.id} value={subject.name}>{subject.name}{subject.isActive ? '' : ' (inactive)'}</option>
            ))}
          </Select>
          <Select aria-label="Show questions of type" value={query.type} onChange={event => setType(event.target.value)}>
            <option value="">All types</option>
            <option value="MCQ">MCQ</option>
            <option value="NUMERICAL">Numerical</option>
          </Select>
        </div>

        <div role="status" className="flex flex-wrap justify-between gap-2 text-sm text-slate-500">
          <span>Showing {firstRow}-{lastRow} of {total.toLocaleString()} questions.</span>
          {loading && <span>Loading questions…</span>}
        </div>
        {error && <Alert variant="danger" role="alert" action={<Button variant="secondary" size="sm" onClick={retry}>Retry</Button>}>{error}</Alert>}

        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
          <Checkbox
            id="wizard-select-page"
            checked={allPageSelected}
            disabled={pageIds.length === 0 || loading}
            onChange={event => {
              const next = event.currentTarget.checked;
              setSelectedQuestions(current => next ? [...new Set([...current, ...pageIds])] : current.filter(id => !pageIds.includes(id)));
            }}
          />
          <label htmlFor="wizard-select-page" className="cursor-pointer text-sm font-semibold text-slate-700">Select all on this page ({rows.length})</label>
        </div>

        {rows.length === 0 ? (
          loading ? <LoadingBlock label="Loading questions…" /> : <EmptyState icon={Library} title="No matching questions" description="Change the search or filters." className="py-8" />
        ) : (
          <ul className={cn('flex flex-col gap-2', loading && 'opacity-60')} aria-busy={loading}>
            {rows.map(question => {
              const checked = selectedQuestions.includes(question.docId);
              const inputId = `wizard-question-${question.docId}`;
              return (
                <li key={question.docId}>
                  <label
                    htmlFor={inputId}
                    className={cn('flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors',
                      checked ? 'border-brand-300 bg-brand-50/60' : 'border-slate-200 bg-white hover:border-slate-300')}
                  >
                    <Checkbox
                      id={inputId}
                      checked={checked}
                      aria-label={`Include question ${question.questionNumber || question.docId}: ${question.text.slice(0, 80)}`}
                      onChange={event => {
                        const next = event.currentTarget.checked;
                        setSelectedQuestions(current => next ? [...new Set([...current, question.docId])] : current.filter(id => id !== question.docId));
                      }}
                      className="mt-1 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {question.questionNumber ? <span className="text-xs font-semibold text-slate-500 tabular-nums">Q{question.questionNumber}</span> : null}
                        <Badge variant="brand">{question.subject}</Badge>
                        <Badge variant={question.type === 'NUMERICAL' ? 'warning' : 'success'}>{question.type === 'NUMERICAL' ? 'Numerical' : 'MCQ'}</Badge>
                        {question.hasImageOrDiagram && !question.questionImageUrl && (
                          <Badge variant="danger"><AlertTriangle aria-hidden="true" /> Needs image</Badge>
                        )}
                      </span>
                      <span className="mt-1.5 line-clamp-2 block break-words text-sm text-slate-800"><MathRenderer text={question.text} /></span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <nav aria-label="Question pages" className={pagerNavClass}>
          <PagerButtons
            page={query.page + 1}
            totalPages={totalPages}
            prevDisabled={query.page <= 0 || loading}
            nextDisabled={query.page + 1 >= totalPages || loading}
            onPrev={() => setPage(query.page - 1)}
            onNext={() => setPage(query.page + 1)}
          />
        </nav>
      </section>
    </div>
  );
}
