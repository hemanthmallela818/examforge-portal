import { useId } from 'react';
import {
  AlertTriangle, ArrowRight, BookOpen, CheckCircle2, ChevronRight, Clock, FilePlus2, Hourglass, ListOrdered, PenLine, Radio, RefreshCw, School, Trophy, Users
} from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Skeleton, cn } from '../../../components/ui';
import { describeLiveTiming, formatRelativeTime, formatScore, notStartedCount } from './liveOverviewLogic';

/**
 * One live exam. The whole card is a button that opens the exam's detail page.
 * @param {{ exam: import('./liveOverviewLogic').LiveExam, onOpen: () => void }} props
 */
function LiveExamCard({ exam, onOpen }) {
  const titleId = useId();
  const statsId = useId();
  const { liveFor, endsBy } = describeLiveTiming(exam);
  const notStarted = notStartedCount(exam);
  const total = Math.max(exam.assignedStudents, exam.writing + exam.submitted + exam.awaitingFinalization, 1);
  const segment = (/** @type {number} */ value) => `${(value / total) * 100}%`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-labelledby={titleId}
      aria-describedby={statsId}
      className="live-exam-card group flex w-full flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-brand-300 hover:bg-brand-50/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <span className="flex w-full items-start justify-between gap-3">
        <span className="min-w-0">
          <span id={titleId} className="block break-words text-base font-semibold leading-snug text-slate-900">{exam.title}</span>
          {(exam.class || exam.section) && (
            <span className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <School className="size-3.5" aria-hidden="true" />
              {exam.class || 'All classes'} | Section {exam.section || 'All'}
            </span>
          )}
        </span>
        <Badge variant="success" className="shrink-0 tracking-wide">
          <span className="size-2 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" /> LIVE
        </Badge>
      </span>

      <span id={statsId} className="flex w-full flex-col gap-3">
        <span className="grid grid-cols-3 gap-2">
          <span className="rounded-lg bg-brand-50 px-2.5 py-2 ring-1 ring-brand-100">
            <span className="block text-lg font-semibold leading-tight text-brand-700 tabular-nums">{exam.writing}</span>
            <span className="block text-xs text-brand-800">writing now</span>
          </span>
          <span className="rounded-lg bg-emerald-50 px-2.5 py-2 ring-1 ring-emerald-100">
            <span className="block text-lg font-semibold leading-tight text-emerald-700 tabular-nums">{exam.submitted}</span>
            <span className="block text-xs text-emerald-800">submitted</span>
          </span>
          <span className="rounded-lg bg-slate-50 px-2.5 py-2 ring-1 ring-slate-100">
            <span className="block text-lg font-semibold leading-tight text-slate-700 tabular-nums">{notStarted}</span>
            <span className="block text-xs text-slate-600">not started</span>
          </span>
        </span>
        <span className="flex h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <span className="bg-emerald-500" style={{ width: segment(exam.submitted) }} />
          <span className="bg-brand-500" style={{ width: segment(exam.writing) }} />
          <span className="bg-amber-400" style={{ width: segment(exam.awaitingFinalization) }} />
        </span>
        <span className="sr-only">{exam.assignedStudents} students assigned.</span>
        {exam.awaitingFinalization > 0 && (
          <span className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
            <AlertTriangle className="size-3.5" aria-hidden="true" /> {exam.awaitingFinalization} expired attempt(s) awaiting finalization
          </span>
        )}
        <span className="flex flex-col gap-1 text-xs text-slate-500">
          {liveFor && <span className="flex items-center gap-1.5"><Radio className="size-3.5" aria-hidden="true" /> {liveFor}</span>}
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5" aria-hidden="true" />
            {exam.duration ? `${exam.duration} min paper` : 'Duration unknown'}
            {exam.totalQuestions !== null && ` · ${exam.totalQuestions} Qs`}
            {endsBy && ` · ${endsBy}`}
          </span>
        </span>
      </span>
      <span className="mt-auto inline-flex items-center gap-1 text-sm font-semibold text-brand-700" aria-hidden="true">
        Open live exam <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

/**
 * Right-now counter row.
 * @param {{ icon: import('react').ElementType, label: string, value: number | string, hint?: string, tone: 'brand' | 'warning' | 'success' }} props
 */
function NowMetric({ icon: Icon, label, value, hint, tone }) {
  const tones = {
    brand: 'bg-brand-50 text-brand-600 ring-brand-100',
    warning: 'bg-amber-50 text-amber-600 ring-amber-100',
    success: 'bg-emerald-50 text-emerald-600 ring-emerald-100'
  };
  return (
    <div className="flex items-start gap-3">
      <div className={cn('grid size-10 shrink-0 place-items-center rounded-xl ring-1', tones[tone])}>
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
        {hint && <p className="text-xs text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * @typedef {object} LiveOverviewPanelProps
 * @property {ReturnType<typeof import('./useLiveOverview').useLiveOverview>} live
 * @property {(examId: string) => void} onOpenExam
 * @property {() => void} onCreateExam
 * @property {() => void} onGoToQuestionBank
 */

/**
 * Dashboard Overview "home" panels: live exams, students writing now,
 * attempts awaiting finalization, quick actions and recent results.
 * @param {LiveOverviewPanelProps} props
 */
export default function LiveOverviewPanel({ live, onOpenExam, onCreateExam, onGoToQuestionBank }) {
  const { overview, loading, error, fetchLiveOverview } = live;
  const firstLoad = !overview && loading;
  const dash = (/** @type {number | undefined} */ value) => (overview ? Number(value).toLocaleString() : '—');

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-6">
        <Card as="section" aria-labelledby="live-exams-heading">
          <CardHeader className="items-center">
            <div>
              <CardTitle as="h2" id="live-exams-heading"><Radio aria-hidden="true" /> Live exams</CardTitle>
              <CardDescription>Exams students can write right now. Select one to monitor it.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={fetchLiveOverview} disabled={loading} aria-label="Refresh live activity">
              <RefreshCw className={cn(loading && 'animate-spin')} aria-hidden="true" /> Refresh
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {error && (
              <Alert variant="warning" role="alert" action={<Button variant="secondary" size="sm" onClick={fetchLiveOverview}>Retry</Button>}>
                {error}
              </Alert>
            )}
            {firstLoad && (
              <div className="grid gap-4 sm:grid-cols-2" role="status" aria-label="Loading live exams">
                <Skeleton className="h-44 rounded-xl" />
                <Skeleton className="h-44 rounded-xl" />
              </div>
            )}
            {overview && overview.liveExams.length === 0 && (
              <EmptyState
                icon={Radio}
                title="No exams are live"
                description="Start a pending exam from its Manage page, or create a new one."
                action={<Button variant="secondary" onClick={onCreateExam}><FilePlus2 aria-hidden="true" /> Create exam</Button>}
                className="py-8"
              />
            )}
            {overview && overview.liveExams.length > 0 && (
              <ul className="grid gap-4 sm:grid-cols-2" aria-label="Live exams">
                {overview.liveExams.map(exam => (
                  <li key={exam.id} className="flex">
                    <LiveExamCard exam={exam} onOpen={() => onOpenExam(exam.id)} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card as="section" aria-labelledby="recent-results-heading">
          <CardHeader>
            <div>
              <CardTitle as="h2" id="recent-results-heading"><Trophy aria-hidden="true" /> Recent results</CardTitle>
              <CardDescription>The latest submitted attempts across all exams.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="py-3">
            {firstLoad && <Skeleton className="h-24" />}
            {overview && overview.recentResults.length === 0 && (
              <p className="py-4 text-sm text-slate-500">No results have been submitted yet.</p>
            )}
            {overview && overview.recentResults.length > 0 && (
              <ul className="-mx-2 flex flex-col divide-y divide-slate-100" aria-label="Recent results">
                {overview.recentResults.map(result => (
                  <li key={result.id}>
                    <button
                      type="button"
                      onClick={() => onOpenExam(result.examId)}
                      className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-900">{result.studentName}</span>
                        <span className="block truncate text-xs text-slate-500">{result.studentId} · {result.examTitle}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-slate-900 tabular-nums">{formatScore(result.totalScore, result.maxScore)}</span>
                        <span className="w-20 text-right text-xs text-slate-500">{formatRelativeTime(result.submittedAt)}</span>
                        <ChevronRight className="size-4 text-slate-400" aria-hidden="true" />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-6">
        <Card as="section" aria-labelledby="right-now-heading">
          <CardHeader>
            <CardTitle as="h2" id="right-now-heading"><Users aria-hidden="true" /> Right now</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <NowMetric icon={PenLine} tone="brand" label="Students writing now" value={dash(overview?.studentsWriting)} hint="Attempts with time remaining" />
            <NowMetric
              icon={overview && overview.awaitingFinalization > 0 ? Hourglass : CheckCircle2}
              tone={overview && overview.awaitingFinalization > 0 ? 'warning' : 'success'}
              label="Awaiting finalization"
              value={dash(overview?.awaitingFinalization)}
              hint={overview && overview.awaitingFinalization > 0
                ? 'Expired attempts are finalized by the scheduler, or from Database Cleaner.'
                : 'No expired attempts are waiting.'}
            />
          </CardContent>
        </Card>

        <Card as="section" aria-labelledby="quick-actions-heading">
          <CardHeader>
            <CardTitle as="h2" id="quick-actions-heading"><ListOrdered aria-hidden="true" /> Quick actions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            <Button onClick={onCreateExam} className="w-full justify-start">
              <FilePlus2 aria-hidden="true" /> Create exam
            </Button>
            <Button variant="secondary" onClick={onGoToQuestionBank} className="w-full justify-start">
              <BookOpen aria-hidden="true" /> Open Question Bank
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                const target = document.getElementById('all-examinations');
                target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
                target?.focus({ preventScroll: true });
              }}
            >
              <ArrowRight aria-hidden="true" /> Jump to all examinations
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
