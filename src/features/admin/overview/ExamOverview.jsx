import { useState } from 'react';
import { ArrowRight, BookOpen, CalendarDays, ClipboardList, Clock, FilePlus2, Hash, Inbox, Library, Radio, School, Search, Trash2, Users } from 'lucide-react';
import { Alert, Badge, Button, Card, EmptyState, Input, LoadingBlock, Select, StatCard } from '../../../components/ui';
import { useAdminContext } from '../adminContext';
import { EXAM_LIST_PAGE_SIZE } from '../adminConstants';
import { ExamStatusBadge, PagerButtons, pagerNavClass } from '../shared/AdminUi';
import StandaloneExamWizard from '../wizard/StandaloneExamWizard';
import LiveOverviewPanel from './LiveOverviewPanel';
import { useLiveOverview } from './useLiveOverview';

const formatCount = (/** @type {unknown} */ value) => (value === null || value === undefined ? '—' : Number(value).toLocaleString());

/**
 * @typedef {object} ExamOverviewProps
 * @property {ReturnType<typeof import('./useExams').useExams>} examList
 * @property {(examId: string) => void} onManageExam
 * @property {(examId: string) => void} onDeleteExam
 * @property {() => void} onGoToQuestionBank
 */

/**
 * Dashboard overview: totals, examination filters, the create-exam card and the paged exam cards.
 * @param {ExamOverviewProps} props
 */
export default function ExamOverview({ examList, onManageExam, onDeleteExam, onGoToQuestionBank }) {
  const { dataLoadState, tableCounts } = useAdminContext();
  const [wizardOpen, setWizardOpen] = useState(false);
  // Realtime-driven totals change when sessions start/end or results arrive.
  const live = useLiveOverview({
    enabled: true,
    refreshKey: `${tableCounts.active_sessions}|${tableCounts.student_results}|${tableCounts.cbt_exams}`
  });
  const {
    exams,
    fetchExams,
    examSearchInput,
    setExamSearchInput,
    examSearch,
    setExamSearch,
    examStatusFilter,
    setExamStatusFilter,
    examListPage,
    setExamListPage,
    examListTotal,
    examListSnapshot
  } = examList;

  const totalPages = Math.max(1, Math.ceil(examListTotal / EXAM_LIST_PAGE_SIZE));
  const confirmedFirstRow = examListTotal === 0 ? 0 : (examListSnapshot.page * EXAM_LIST_PAGE_SIZE) + 1;
  const confirmedLastRow = examListTotal === 0 ? 0 : Math.min(examListTotal, confirmedFirstRow + exams.length - 1);
  const queryChanged = examListSnapshot.page !== examListPage
    || examListSnapshot.search !== examSearch
    || examListSnapshot.status !== examStatusFilter;
  const listState = /** @type {Partial<import('../../../types').DataLoadEntry>} */ (dataLoadState.exams || {});
  const rowActionsDisabled = queryChanged || Boolean(listState.loading || listState.error);
  const applySearch = () => {
    const nextSearch = examSearchInput.trim();
    setExamListPage(0);
    if (nextSearch === examSearch && examListPage === 0) fetchExams();
    else setExamSearch(nextSearch);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={ClipboardList} label="Examinations" value={formatCount(tableCounts.cbt_exams)} tone="brand" />
        <StatCard icon={Users} label="Student accounts" value={formatCount(tableCounts.students)} tone="violet" />
        <StatCard icon={Library} label="Questions in bank" value={formatCount(tableCounts.question_bank)} tone="warning" />
        <StatCard icon={Radio} label="Live exam sessions" value={formatCount(tableCounts.active_sessions)} tone="success" />
      </div>

      <LiveOverviewPanel
        live={live}
        onOpenExam={onManageExam}
        onCreateExam={() => setWizardOpen(true)}
        onGoToQuestionBank={onGoToQuestionBank}
      />

      <section id="all-examinations" tabIndex={-1} aria-label="Filter examinations" className="scroll-mt-24 rounded-2xl focus:outline-none border border-slate-200 bg-white p-4 shadow-card sm:p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input type="search" aria-label="Search examinations by title, class, or section" placeholder="Title, class, or section" maxLength={100} value={examSearchInput} disabled={listState.loading} onChange={event => setExamSearchInput(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); applySearch(); }
            }} className="pl-9" />
          </div>
          <Button variant="secondary" disabled={listState.loading} onClick={applySearch}>Search</Button>
          {(examSearch || examSearchInput) && <Button variant="ghost" disabled={listState.loading} onClick={() => {
            setExamSearchInput('');
            setExamSearch('');
            setExamListPage(0);
          }}>Clear search</Button>}
          <div className="min-w-[160px]">
            <Select aria-label="Filter examinations by status" value={examStatusFilter} disabled={listState.loading} onChange={event => {
              setExamStatusFilter(event.target.value);
              setExamListPage(0);
            }}>
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="ACTIVE">Active</option>
              <option value="ENDED">Ended</option>
            </Select>
          </div>
        </div>
        <div role="status" className="mt-3 flex flex-wrap justify-between gap-3 text-sm text-slate-500">
          <span>Showing confirmed examinations {confirmedFirstRow}-{confirmedLastRow} of {examListTotal.toLocaleString()}.</span>
          {(listState.loading || queryChanged) && <span>Loading requested examination page…</span>}
        </div>
        {queryChanged && listState.error && <Alert variant="danger" role="alert" className="mt-3">The cards below are the last confirmed page. Management actions are disabled until the requested page loads.</Alert>}
      </section>

      <div aria-busy={listState.loading} className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 350px), 1fr))' }}>
        {/* Create New Exam Card */}
        <div className="animate-fade-in flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white/60 p-8 text-center">
          <div className="mb-4 grid size-12 place-items-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <FilePlus2 className="size-6" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold text-slate-900">Create New Exam</h3>
          <p className="mb-5 mt-1 max-w-xs text-sm text-slate-500">Follow the step-by-step wizard, or select questions directly in the Question Bank.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setWizardOpen(true)}>
              <FilePlus2 aria-hidden="true" /> Step-by-step wizard
            </Button>
            <Button variant="secondary" onClick={onGoToQuestionBank}>
              <BookOpen aria-hidden="true" /> Go to Question Bank
            </Button>
          </div>
        </div>

        {/* Existing Exams List */}
        {exams.map(exam => (
          <Card key={exam.id} className="admin-exam-card animate-fade-in flex flex-col transition-shadow hover:shadow-md">
            <div className="flex items-start justify-between gap-3 px-5 pt-5">
              <h3 className="min-w-0 break-words text-base font-semibold leading-snug text-slate-900">{exam.title}</h3>
              <ExamStatusBadge status={exam.status} />
            </div>

            <div className="flex flex-1 flex-col gap-3 px-5 py-4">
              {exam.class && exam.section && (
                <div>
                  <Badge variant="brand">
                    <School aria-hidden="true" /> {exam.class} | Section {exam.section}
                  </Badge>
                </div>
              )}
              <p className="sr-only">Duration & Questions:</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-100">
                  <Clock className="size-4 text-slate-400" aria-hidden="true" />
                  <span className="text-sm font-semibold text-slate-900 tabular-nums">{exam.questionsData?.duration || 180} mins</span>
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-100">
                  <Hash className="size-4 text-slate-400" aria-hidden="true" />
                  <span className="text-sm font-semibold text-slate-900 tabular-nums">{exam.questionsData?.totalQuestions || 0} Qs</span>
                </div>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <CalendarDays className="size-3.5" aria-hidden="true" /> Created: {new Date(exam.created_at).toLocaleDateString()}
              </p>
            </div>

            <div className="flex gap-2 border-t border-slate-100 px-5 py-4">
              <Button variant="secondary" disabled={rowActionsDisabled} className="flex-1" onClick={() => onManageExam(exam.id)}>
                Manage <ArrowRight aria-hidden="true" />
              </Button>
              <Button variant="danger-outline" size="icon" className="size-10" disabled={rowActionsDisabled} aria-label={`Delete ${exam.title}`} onClick={() => onDeleteExam(exam.id)} title="Delete Exam">
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {exams.length === 0 && listState.loading && <LoadingBlock label="Loading examinations…" />}
      {exams.length === 0 && !listState.loading && (
        <EmptyState icon={Inbox} title="No examinations found" description="No examinations match the current filters." />
      )}
      <nav aria-label="Examination list pages" className={pagerNavClass}>
        <PagerButtons
          page={examListPage + 1}
          totalPages={totalPages}
          prevDisabled={examListPage <= 0 || rowActionsDisabled}
          nextDisabled={examListPage + 1 >= totalPages || rowActionsDisabled}
          onPrev={() => setExamListPage(page => Math.max(0, page - 1))}
          onNext={() => setExamListPage(page => Math.min(totalPages - 1, page + 1))}
        />
      </nav>
      {wizardOpen && (
        <StandaloneExamWizard
          onClose={() => setWizardOpen(false)}
          onExamCreated={() => {
            examList.resetExamListQuery();
            fetchExams();
            live.fetchLiveOverview();
          }}
        />
      )}
    </div>
  );
}
