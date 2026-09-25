import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Hash, Library, ListOrdered, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EmptyState, Input, LoadingBlock, Select, cn
} from '../../../components/ui';
import QuestionEditor from '../../../components/QuestionEditor';
import MathRenderer from '../../../components/MathRenderer';
import StorageImage from '../../../components/StorageImage';
import { useAdminContext } from '../adminContext';
import { QUESTION_BANK_PAGE_SIZE } from '../adminConstants';
import { PagerButtons, pagerNavClass } from '../shared/AdminUi';
import CreateExamCard from './CreateExamCard';
import ExamCreationWizard from '../wizard/ExamCreationWizard';

/**
 * One question in the bank list: selection, badges, text, media and answer key.
 * @param {{
 *   question: import('../../../types').QuestionBankItem,
 *   selected: boolean,
 *   onToggle: (checked: boolean) => void,
 *   onEdit: () => void,
 *   onDelete: () => void
 * }} props
 */
function QuestionBankItem({ question: q, selected, onToggle, onEdit, onDelete }) {
  return (
    <div className={cn('flex gap-3 rounded-xl border p-4 transition-colors', selected ? 'border-brand-300 bg-brand-50/60' : 'border-slate-200 bg-white hover:border-slate-300')}>
      <Checkbox
        checked={selected}
        aria-label={`Select question ${q.questionNumber || q.docId}: ${q.text.slice(0, 80)}`}
        onChange={(e) => onToggle(e.currentTarget.checked)}
        className="mt-1 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="brand">{q.subject}</Badge>
            <Badge variant={q.type === 'NUMERICAL' ? 'warning' : 'success'}>
              {q.type === 'NUMERICAL' ? 'NUMERICAL VALUE' : 'MCQ'}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onEdit}>
              <Pencil aria-hidden="true" /> Edit
            </Button>
            <Button variant="ghost" size="icon" className="size-8 text-red-600 hover:bg-red-50 hover:text-red-700" onClick={onDelete} aria-label={`Delete question ${q.questionNumber || q.docId}`} title="Delete question">
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
        <div className="my-2.5 text-sm font-medium leading-relaxed text-slate-900">
          {q.questionNumber && <span className="mr-2 text-slate-500 tabular-nums">Q{q.questionNumber}.</span>}
          <MathRenderer text={q.text} />
          {q.hasImageOrDiagram && !q.questionImageUrl && (
            <Badge variant="danger" className="ml-2 align-middle">
              <AlertTriangle aria-hidden="true" /> Requires Image Upload
            </Badge>
          )}
        </div>
        {q.questionImageUrl && (
          <div className="mb-2.5">
            <StorageImage src={q.questionImageUrl} alt="Question" className="max-h-[100px] max-w-full rounded border border-slate-200" />
          </div>
        )}
        {q.type === 'NUMERICAL' || !q.options || q.options.length === 0 ? (
          <div className="inline-flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-800">
            <Hash className="size-4" aria-hidden="true" /> Correct Numerical Answer: {q.correctAnswer}
          </div>
        ) : (
          <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
            {q.options.map((opt, i) => (
              <div key={i} className={cn('flex flex-col rounded-lg px-2.5 py-1.5', Number(q.correctAnswer) === i ? 'bg-emerald-50 font-semibold text-emerald-700 ring-1 ring-emerald-200' : 'bg-slate-50')}>
                <span className="flex items-start gap-1.5">
                  {Number(q.correctAnswer) === i && <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
                  <span>{String.fromCharCode(65 + i)}) <MathRenderer text={opt} /></span>
                </span>
                {q.optionImageUrls?.[i] && (
                  <StorageImage src={q.optionImageUrls[i]} alt={`Option ${i}`} className="mt-1 max-h-[60px] max-w-full self-start rounded" />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Question Bank tab: paged, filterable question list beside the Create Exam card.
 * @param {{
 *   questionBankState: import('./useQuestionBank').QuestionBankState,
 *   examBuilder: import('./useExamBuilder').ExamBuilder,
 *   onDeleteAllQuestions: () => void
 * }} props
 */
export default function QuestionBankView({ questionBankState, examBuilder, onDeleteAllQuestions }) {
  const { dataLoadState, isRootDeveloper, catalog } = useAdminContext();
  const { subjectCatalog, activeSubjectNames, compareSubjects } = catalog;
  const [wizardOpen, setWizardOpen] = useState(false);
  const {
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
  } = questionBankState;

  /** @type {Record<string, import('../../../types').QuestionBankItem[]>} */
  const groupedQuestions = {};
  questionBank.forEach(q => {
    const subj = q.subject || 'General';
    if (!groupedQuestions[subj]) groupedQuestions[subj] = [];
    groupedQuestions[subj].push(q);
  });

  // Sort questions within each subject by question number
  Object.keys(groupedQuestions).forEach(subj => {
    groupedQuestions[subj].sort((a, b) => (a.questionNumber || 0) - (b.questionNumber || 0));
  });

  // Configured subject order (Subjects & Patterns); unknown subjects sort last.
  const sortedSubjects = Object.keys(groupedQuestions).sort(compareSubjects);
  const totalPages = Math.max(1, Math.ceil(questionBankTotal / QUESTION_BANK_PAGE_SIZE));
  const confirmedFirstRow = questionBankTotal === 0 ? 0 : (questionBankSnapshot.page * QUESTION_BANK_PAGE_SIZE) + 1;
  const confirmedLastRow = questionBankTotal === 0 ? 0 : Math.min(questionBankTotal, confirmedFirstRow + questionBank.length - 1);
  const questionQueryChanged = questionBankSnapshot.page !== questionBankPage
    || questionBankSnapshot.search !== questionSearch
    || questionBankSnapshot.subject !== questionSubjectFilter
    || questionBankSnapshot.type !== questionTypeFilter;
  const questionState = dataLoadState.questions || /** @type {Partial<import('../../../types').DataLoadEntry>} */ ({});
  const questionActionsDisabled = questionQueryChanged || Boolean(questionState.loading || questionState.error);
  const pageIds = questionBank.map(question => question.docId);
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedQuestions.includes(id));

  const applyQuestionSearch = () => {
    const nextSearch = questionSearchInput.trim();
    setQuestionBankPage(0);
    if (nextSearch === questionSearch && questionBankPage === 0) fetchQuestionBank();
    else setQuestionSearch(nextSearch);
  };

  return (
    <div className="animate-fade-in flex h-full flex-col gap-6">
      {editingQuestion && (
        <QuestionEditor
          question={editingQuestion}
          existingQuestions={questionBank}
          subjects={activeSubjectNames}
          onSave={handleSaveQuestion}
          onCancel={() => setEditingQuestion(null)}
        />
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="min-w-0">
          <CardHeader className="items-center">
            <CardTitle as="h2"><Library aria-hidden="true" /> Question Bank</CardTitle>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="border-brand-200 text-brand-700 hover:border-brand-300 hover:bg-brand-50"
                onClick={() => handleAddBlankQuestion('MCQ')}
              >
                <Plus aria-hidden="true" /> Create Blank MCQ
              </Button>
              <Button
                variant="warning"
                size="sm"
                onClick={() => handleAddBlankQuestion('NUMERICAL')}
              >
                <Plus aria-hidden="true" /> Create Blank Numerical (NAT)
              </Button>
            </div>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[240px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                <Input
                  type="search"
                  aria-label="Search questions by number, text, or subject"
                  placeholder="Search by question number (e.g. 15), text, or subject..."
                  maxLength={100}
                  value={questionSearchInput}
                  onChange={(e) => setQuestionSearchInput(e.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyQuestionSearch(); } }}
                  className="pl-9"
                />
              </div>
              <Button variant="secondary" onClick={applyQuestionSearch}>Search</Button>
              {(questionSearch || questionSearchInput) && <Button variant="ghost" onClick={() => {
                setQuestionSearchInput('');
                setQuestionSearch('');
                setQuestionBankPage(0);
              }}>Clear search</Button>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[170px]">
                <Select aria-label="Filter questions by subject" value={questionSubjectFilter} onChange={event => {
                  setQuestionSubjectFilter(event.target.value);
                  setQuestionBankPage(0);
                }}>
                  <option value="">All subjects</option>
                  {subjectCatalog.map(subject => (
                    <option key={subject.id} value={subject.name}>{subject.name}{subject.isActive ? '' : ' (inactive)'}</option>
                  ))}
                  {questionSubjectFilter && !subjectCatalog.some(subject => subject.name === questionSubjectFilter) && (
                    <option value={questionSubjectFilter}>{questionSubjectFilter}</option>
                  )}
                </Select>
              </div>
              <div className="min-w-[150px]">
                <Select aria-label="Filter questions by type" value={questionTypeFilter} onChange={event => {
                  setQuestionTypeFilter(event.target.value);
                  setQuestionBankPage(0);
                }}>
                  <option value="">All types</option>
                  <option value="MCQ">MCQ</option>
                  <option value="NUMERICAL">Numerical</option>
                </Select>
              </div>
            </div>

            <div role="status" className="flex flex-wrap justify-between gap-3 text-sm text-slate-500">
              <span>Showing confirmed questions {confirmedFirstRow}-{confirmedLastRow} of {questionBankTotal.toLocaleString()}. {selectedQuestions.length} selected across all pages.</span>
              {(questionState.loading || questionQueryChanged) && <span>Loading requested Question Bank page…</span>}
            </div>
            {questionQueryChanged && questionState.error && (
              <Alert variant="danger" role="alert">The list below is the last confirmed page. Question actions are disabled until the requested page loads.</Alert>
            )}

            <fieldset disabled={questionActionsDisabled} aria-busy={questionState.loading} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <Checkbox id="selectAll"
                    checked={allPageSelected}
                    disabled={pageIds.length === 0}
                    onChange={(e) => {
                      const nextChecked = e.currentTarget.checked;
                      setSelectedQuestions(current => nextChecked
                        ? [...new Set([...current, ...pageIds])]
                        : current.filter(id => !pageIds.includes(id)));
                    }}
                  />
                  <label htmlFor="selectAll" className="cursor-pointer text-sm font-semibold text-slate-700">Select this page ({questionBank.length})</label>
                </div>
                {isRootDeveloper && questionBankTotal > 0 && (
                  <Button
                    variant="danger-outline"
                    size="sm"
                    onClick={onDeleteAllQuestions}
                  >
                    <Trash2 aria-hidden="true" /> Delete All Questions
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-6">
                {questionBank.length === 0 ? (
                  questionState.loading ? (
                    <LoadingBlock label="Loading questions…" />
                  ) : (
                    <EmptyState
                      icon={Library}
                      title={questionBankTotal === 0 && !questionSearch && !questionSubjectFilter && !questionTypeFilter ? 'No questions in bank. Use the Question Editor to create new questions.' : 'No matching questions found.'}
                    />
                  )
                ) : (
                  sortedSubjects.map(subject => (
                    <div key={subject}>
                      <h3 className="mb-3 flex items-center gap-2 border-b border-slate-200 pb-2 text-base font-semibold text-slate-900">
                        {subject}
                        <Badge variant="neutral" className="tabular-nums">{groupedQuestions[subject].length}</Badge>
                      </h3>
                      <div className="flex flex-col gap-3">
                        {groupedQuestions[subject].map(q => (
                          <QuestionBankItem
                            key={q.docId}
                            question={q}
                            selected={selectedQuestions.includes(q.docId)}
                            onToggle={nextChecked => setSelectedQuestions(current => nextChecked
                              ? [...new Set([...current, q.docId])]
                              : current.filter(id => id !== q.docId))}
                            onEdit={() => setEditingQuestion(q)}
                            onDelete={() => handleDeleteQuestion(q.docId)}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <nav aria-label="Question Bank pages" className={pagerNavClass}>
                <PagerButtons
                  page={questionBankPage + 1}
                  totalPages={totalPages}
                  prevDisabled={questionBankPage <= 0 || questionActionsDisabled}
                  nextDisabled={questionBankPage + 1 >= totalPages || questionActionsDisabled}
                  onPrev={() => setQuestionBankPage(page => Math.max(0, page - 1))}
                  onNext={() => setQuestionBankPage(page => Math.min(totalPages - 1, page + 1))}
                />
              </nav>
            </fieldset>
          </CardContent>
        </Card>

        {/* Create Exam Card (quick path) plus the step-by-step wizard entry point */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-24">
          <CreateExamCard examBuilder={examBuilder} selectedQuestions={selectedQuestions} knownQuestionSubjects={knownQuestionSubjects} />
          <Button variant="secondary" className="w-full" onClick={() => setWizardOpen(true)}>
            <ListOrdered aria-hidden="true" /> Step-by-step wizard
          </Button>
        </div>
      </div>
      {wizardOpen && (
        <ExamCreationWizard
          examBuilder={examBuilder}
          selectedQuestions={selectedQuestions}
          setSelectedQuestions={setSelectedQuestions}
          initialSubjectsById={knownQuestionSubjects}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  );
}
