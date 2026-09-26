import { BarChart3, BookOpen, CalendarClock, CheckCircle2, CircleStop, ClipboardList, Clock, CloudUpload, Hourglass, IdCard, Inbox, LogOut, Play, Radio, RefreshCw, RotateCcw, Timer, TrendingUp, Users, XCircle } from 'lucide-react';
import { APP_ERROR, classifyAppError } from '../appErrors';
import { Badge, Button, Card, EmptyState, LoadingBlock, cn } from './ui';
import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../supabase';
import {
  sessionBelongsToStudent,
  clearOfflineRecoveryRecord,
  readPendingSubmissionRecord,
  beginPendingSubmissionSync,
  finishPendingSubmissionSync,
  readPendingTerminationRecord
} from '../examLogic';
import { fetchAllRows } from '../paginatedQuery';
import { useRemainingSeconds } from '../features/exam/examClock';
import BrandLogo from '../branding/BrandLogo';
import { useBranding } from '../branding/brandingStore';
import ThemeToggle from '../theme/ThemeToggle';

/**
 * @typedef {import('../features/exam/examSessionHelpers').CurrentStudent} CurrentStudent
 * @typedef {import('../features/exam/examSessionHelpers').Scorecard} Scorecard
 * @typedef {import('../features/exam/examSessionHelpers').ActiveExam & {
 *   status?: string,
 *   class?: string | null,
 *   section?: string | null,
 *   created_at?: string
 * }} DashboardExam
 */

/** @typedef {'live' | 'upcoming' | 'completed' | 'ended'} ExamGroupKey */

/** @type {ReadonlyArray<{ key: ExamGroupKey, title: string, hint: string, icon: import('react').ElementType, iconTone: string, cardBorder: string }>} */
const EXAM_GROUPS = [
  { key: 'live', title: 'Live now', hint: 'Open for you to start or resume', icon: Radio, iconTone: 'text-brand-600', cardBorder: '*:border-brand-200' },
  { key: 'upcoming', title: 'Upcoming', hint: 'Waiting for your administrator', icon: CalendarClock, iconTone: 'text-amber-600', cardBorder: '*:border-slate-200' },
  { key: 'completed', title: 'Completed', hint: 'Submitted and scored', icon: CheckCircle2, iconTone: 'text-emerald-600', cardBorder: '*:border-slate-200' },
  { key: 'ended', title: 'Ended', hint: 'Closed without a submission', icon: CircleStop, iconTone: 'text-slate-500', cardBorder: '*:border-slate-200' }
];

/**
 * @param {DashboardExam} exam
 * @param {Set<string>} completedExams
 * @param {string | null} endingExamId exam ended on this device whose result has not reached the server yet
 * @returns {ExamGroupKey}
 */
const examGroupOf = (exam, completedExams, endingExamId) => {
  if (completedExams.has(exam.id) || exam.id === endingExamId) return 'completed';
  if (exam.status === 'ACTIVE') return 'live';
  if (exam.status === 'ENDED') return 'ended';
  return 'upcoming';
};

/** @param {Scorecard} result @returns {number | null} */
const scorePercent = (result) => {
  const max = Number(result?.maxScore);
  const total = Number(result?.totalScore);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(total)) return null;
  return (total / max) * 100;
};

/** @param {number} value */
const formatPercent = (value) => `${Math.round(value)}%`;

/** @param {number} seconds */
const formatCountdown = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Institution logo and name with the Light / Dark / System switch. */
const StudentBrandBar = () => {
  const { displayName } = useBranding();
  return (
    <div className="student-brand-bar flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandLogo
          imageClassName="h-9 w-auto max-w-[160px]"
          tileClassName="size-9 rounded-xl bg-brand-600 text-white"
          iconClassName="size-5"
        />
        <span className="truncate text-sm font-semibold text-slate-700">{displayName}</span>
      </div>
      <ThemeToggle />
    </div>
  );
};

// Ticks on the shared exam clock, so only this line re-renders every second.
/** @param {{ endTime: number }} props */
const AttemptCountdown = ({ endTime }) => {
  const remaining = useRemainingSeconds(endTime) ?? 0;
  return (
    <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1 text-sm font-medium text-brand-800 ring-1 ring-brand-100">
      <Timer className="size-4 shrink-0 text-brand-600" aria-hidden="true" />
      {remaining > 0
        ? <span>Time remaining in your attempt: <span className="font-semibold tabular-nums">{formatCountdown(remaining)}</span></span>
        : <span>Your attempt time has ended.</span>}
    </p>
  );
};

const TREND_WIDTH = 320;
const TREND_HEIGHT = 80;
const TREND_PAD = 10;

/** @param {{ points: Array<{ id: string, title: string, percent: number }> }} props */
const ScoreTrend = ({ points }) => {
  const [hovered, setHovered] = useState(/** @type {number | null} */ (null));
  if (points.length === 0) return null;
  const values = points.map(point => point.percent);
  const latest = values[values.length - 1];
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const best = Math.max(...values);
  const minY = Math.min(0, ...values);
  const maxY = Math.max(100, ...values);
  const x = (/** @type {number} */ index) => points.length === 1
    ? TREND_WIDTH / 2
    : TREND_PAD + (index * (TREND_WIDTH - TREND_PAD * 2)) / (points.length - 1);
  const y = (/** @type {number} */ value) => TREND_PAD + ((maxY - value) * (TREND_HEIGHT - TREND_PAD * 2)) / (maxY - minY || 1);
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point.percent).toFixed(1)}`).join(' ');
  const active = hovered === null ? null : points[hovered];
  const summary = `Score trend across ${points.length} completed exam${points.length === 1 ? '' : 's'}: ${points.map(point => formatPercent(point.percent)).join(', ')}.`;

  return (
    <Card className="student-score-trend p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="flex min-w-0 flex-col gap-3 sm:w-56 sm:shrink-0">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100">
              <TrendingUp className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-slate-900">Your score trend</h3>
              <p className="text-xs text-slate-500">Percentage across completed exams</p>
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200">
              <dt className="text-xs text-slate-500">Latest</dt>
              <dd className="text-base font-semibold text-slate-900 tabular-nums">{formatPercent(latest)}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200">
              <dt className="text-xs text-slate-500">Average</dt>
              <dd className="text-base font-semibold text-slate-900 tabular-nums">{formatPercent(average)}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 px-2 py-1.5 ring-1 ring-slate-200">
              <dt className="text-xs text-slate-500">Best</dt>
              <dd className="text-base font-semibold text-slate-900 tabular-nums">{formatPercent(best)}</dd>
            </div>
          </dl>
        </div>
        <figure className="relative m-0 min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
            className="block h-20 w-full overflow-visible"
            role="img"
            aria-label={summary}
            onMouseLeave={() => setHovered(null)}
          >
            {/* Recessive guides at 0% (or the lowest score) and 100%. */}
            <line x1={TREND_PAD} x2={TREND_WIDTH - TREND_PAD} y1={y(maxY)} y2={y(maxY)} className="stroke-slate-200" strokeWidth="1" strokeDasharray="3 4" />
            <line x1={TREND_PAD} x2={TREND_WIDTH - TREND_PAD} y1={y(minY)} y2={y(minY)} className="stroke-slate-300" strokeWidth="1" />
            {points.length > 1 && (
              <path d={path} fill="none" className="stroke-brand-600" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            )}
            {points.map((point, index) => (
              <g key={point.id}>
                <circle
                  cx={x(index)}
                  cy={y(point.percent)}
                  r={index === points.length - 1 || hovered === index ? 5 : 4}
                  className={index === points.length - 1 || hovered === index ? 'fill-brand-600 stroke-white' : 'fill-white stroke-brand-600'}
                  strokeWidth="2"
                />
                {/* Larger invisible hit target for pointer hover. */}
                <circle
                  cx={x(index)}
                  cy={y(point.percent)}
                  r="14"
                  fill="transparent"
                  onMouseEnter={() => setHovered(index)}
                >
                  <title>{`${point.title}: ${formatPercent(point.percent)}`}</title>
                </circle>
              </g>
            ))}
          </svg>
          <figcaption className="mt-1 flex min-h-5 items-center justify-between gap-2 text-xs text-slate-500">
            {active
              ? <span className="truncate"><span className="font-medium text-slate-700">{active.title}</span> · <span className="tabular-nums">{formatPercent(active.percent)}</span></span>
              : <span>Oldest</span>}
            {!active && <span>Latest</span>}
          </figcaption>
          <ol className="sr-only">
            {points.map(point => <li key={point.id}>{point.title}: {formatPercent(point.percent)}</li>)}
          </ol>
        </figure>
      </div>
    </Card>
  );
};

/**
 * @param {{
 *   student: CurrentStudent,
 *   onLogout: () => void,
 *   onStartExam: (exam: DashboardExam) => void,
 *   onViewResult?: (scorecard: Scorecard) => void
 * }} props
 */
const StudentDashboard = ({ student, onLogout, onStartExam, onViewResult }) => {
  const [exams, setExams] = useState(/** @type {DashboardExam[]} */ ([]));
  const [completedExams, setCompletedExams] = useState(/** @type {Set<string>} */ (new Set()));
  const [completedResults, setCompletedResults] = useState(/** @type {Record<string, Scorecard>} */ ({}));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingSubmissionExamId, setPendingSubmissionExamId] = useState(() => {
    return readPendingSubmissionRecord({ student, userUuid: student?.docId })?.examId || null;
  });
  const [isSyncingPending, setIsSyncingPending] = useState(false);
  const refreshTimer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const activeLocalSession = (() => {
    try {
      const raw = localStorage.getItem('cbt_active_exam_session');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!sessionBelongsToStudent(parsed, student)) {
        throw new Error('This saved submission belongs to a different student.');
      }
      if (sessionBelongsToStudent(parsed, student) && parsed?.activeExam && parsed?.endTime > Date.now()) return parsed;
    } catch {}
    return null;
  })();

  // An attempt ended on this device (terminated) whose result is still on its
  // way to the server. It is over: never offer Start or Resume for it.
  const endingExamId = (() => {
    const pending = readPendingTerminationRecord({ student, userUuid: student?.docId });
    return pending?.examId ? String(pending.examId) : null;
  })();

  const syncPendingOfflineSubmission = async () => {
    if (!pendingSubmissionExamId) return;
    const parsed = readPendingSubmissionRecord({
      student,
      examId: pendingSubmissionExamId,
      userUuid: student?.docId
    });
    if (!parsed) {
      setPendingSubmissionExamId(null);
      return;
    }
    if (!beginPendingSubmissionSync({ student, examId: pendingSubmissionExamId, userUuid: student?.docId })) return;
    try {
      setIsSyncingPending(true);
      const { data: finalResults, error } = await supabase.rpc('submit_exam', {
        exam_id_param: pendingSubmissionExamId,
        responses_param: parsed.responses
      });
      if (error) {
        if (classifyAppError(error) === APP_ERROR.ALREADY_SUBMITTED) {
          const { data: committedResult } = await supabase
            .from('student_results')
            .select('*')
            .eq('student_id', student.id)
            .eq('exam_id', pendingSubmissionExamId)
            .single();
          if (committedResult) {
            clearOfflineRecoveryRecord({ student, examId: pendingSubmissionExamId });
            setPendingSubmissionExamId(null);
            if (onViewResult) {
              onViewResult({
                totalScore: committedResult.total_score,
                maxScore: committedResult.max_score,
                correct: committedResult.correct,
                incorrect: committedResult.incorrect,
                unattempted: committedResult.unattempted,
                subjectScores: committedResult.subject_scores
              });
            } else {
              await fetchExamsAndResults();
            }
            return;
          }
        }
        throw error;
      }
      clearOfflineRecoveryRecord({ student, examId: pendingSubmissionExamId });
      setPendingSubmissionExamId(null);
      if (onViewResult) {
        onViewResult(finalResults);
      } else {
        await fetchExamsAndResults();
      }
    } catch (err) {
      console.error("Offline submission sync error:", err);
      setError("Failed to sync offline submission. Please check connection and try again.");
    } finally {
      setIsSyncingPending(false);
      finishPendingSubmissionSync({ student, examId: pendingSubmissionExamId, userUuid: student?.docId });
    }
  };

  const fetchExamsAndResults = async () => {
    try {
      setError('');
      // 1. Fetch completed exam results for this student
      const resultsData = await fetchAllRows((from, to) => supabase
        .from('student_results')
        .select('exam_id, total_score, max_score, correct, incorrect, unattempted, subject_scores')
        .eq('student_id', student.id)
        .order('exam_id', { ascending: true })
        .range(from, to));
      const completedSet = new Set((resultsData || []).map(r => r.exam_id));
      /** @type {Record<string, Scorecard>} */
      const resultsMap = {};
      (resultsData || []).forEach(r => {
        resultsMap[r.exam_id] = {
          totalScore: r.total_score,
          maxScore: r.max_score,
          correct: r.correct,
          incorrect: r.incorrect,
          unattempted: r.unattempted,
          subjectScores: r.subject_scores
        };
      });
      setCompletedExams(completedSet);
      setCompletedResults(resultsMap);

      // 2. Fetch exams matching this student's class and section
      const studentClass = student.class || null;
      const studentSection = student.section || null;
      const examsData = await fetchAllRows((from, to) => supabase
        .from('cbt_exams')
        .select('id, title, status, class, section, created_at, questions_data')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to));
      
      const filteredExams = (examsData || []).filter(ex => {
        if (!ex.class || ex.class === 'All' || (studentClass && ex.class === studentClass)) {
          if (!ex.section || ex.section === 'All' || (studentSection && ex.section === studentSection)) {
            return true;
          }
        }
        return false;
      });

      setExams(filteredExams.map(ex => ({
        ...ex,
        questionsData: ex.questions_data
      })));

    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      setError("Failed to fetch exams. Please check your connection.");
    } finally {
      setLoading(false);
    }
  };

  const scheduleDashboardRefresh = () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchExamsAndResults();
    }, 300);
  };

  useEffect(() => {
    if (!student) return;
    fetchExamsAndResults();

    // Raw papers never enter Realtime. The metadata-only event table is a fast
    // refresh signal; the protected view remains the authoritative read path.
    const examsChannel = supabase
      .channel(`student-exams-${student.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exam_status_events' },
        (/** @type {{ new: import('../types').UntrustedInput, old: import('../types').UntrustedInput }} */ payload) => {
          const examObj = payload.new || payload.old;
          // Refresh if it matches the student's class and section
          if (examObj
            && (!examObj.class || examObj.class === 'All' || examObj.class === student.class)
            && (!examObj.section || examObj.section === 'All' || examObj.section === student.section)) {
            scheduleDashboardRefresh();
          }
        }
      )
      .subscribe();

    // Subscribe to student_results to update completed status dynamically
    const resultsChannel = supabase
      .channel(`student-results-${student.id}`)
      .on(
        'postgres_changes',
        // Server-side filter: each candidate receives only its own result events,
        // instead of every result inserted during a large sitting.
        { event: '*', schema: 'public', table: 'student_results', filter: `student_id=eq.${student.id}` },
        (/** @type {{ new: import('../types').UntrustedInput, old: import('../types').UntrustedInput }} */ payload) => {
          const resultObj = payload.new || payload.old;
          if (resultObj && resultObj.student_id === student.id) {
            scheduleDashboardRefresh();
          }
        }
      )
      .subscribe();

    // Realtime is the fast path; polling is a safety net for school networks
    // that block WebSocket connections. A per-browser random period spreads the
    // polls of a whole class instead of aligning them on the same second.
    const refreshInterval = setInterval(fetchExamsAndResults, 30000 + Math.floor(Math.random() * 15000));

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      clearInterval(refreshInterval);
      supabase.removeChannel(examsChannel);
      supabase.removeChannel(resultsChannel);
    };
  // The subscription lifetime is bound to the authenticated student. Query
  // state is owned inside this component and refreshed by the callbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [student]);

  const groupedExams = useMemo(() => {
    /** @type {Record<ExamGroupKey, DashboardExam[]>} */
    const groups = { live: [], upcoming: [], completed: [], ended: [] };
    exams.forEach(exam => groups[examGroupOf(exam, completedExams, endingExamId)].push(exam));
    return groups;
  }, [exams, completedExams, endingExamId]);

  // Oldest to newest, using the exam creation order the list already carries.
  const trendPoints = useMemo(() => [...groupedExams.completed]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .map(exam => {
      const result = completedResults[exam.id];
      const percent = result ? scorePercent(result) : null;
      return percent === null ? null : { id: exam.id, title: exam.title || 'Exam', percent };
    })
    .filter(point => point !== null), [groupedExams, completedResults]);

  /** @param {DashboardExam} exam */
  const handleStartExam = (exam) => {
    onStartExam(exam);
  };

  const initials = (student?.name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((/** @type {string} */ part) => part[0].toUpperCase())
    .join('') || 'S';

  return (
    <div className="student-dashboard-page min-h-dvh bg-slate-50 px-4 py-8 sm:py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">

        {/* Institution brand and theme */}
        <StudentBrandBar />

        {/* Header bar */}
        <Card className="student-dashboard-header flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex min-w-0 items-center gap-4">
            <div className="grid size-14 shrink-0 place-items-center rounded-full bg-brand-600 text-lg font-semibold text-white ring-4 ring-brand-100" aria-hidden="true">
              {initials}
            </div>
            <div className="min-w-0">
              <span className="text-sm text-slate-500">Welcome back,</span>
              <h2 className="truncate text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{student.name}</h2>
              <div className="student-account-meta mt-2 flex flex-wrap gap-2">
                <Badge variant="neutral"><IdCard aria-hidden="true" /><span><strong className="font-semibold">ID:</strong> {student.id}</span></Badge>
                <Badge variant="brand"><Users aria-hidden="true" /><span><strong className="font-semibold">Class:</strong> {student.class || 'Unassigned'}{student.section ? ` (${student.section})` : ''}</span></Badge>
              </div>
            </div>
          </div>
          <Button variant="secondary" onClick={onLogout} className="shrink-0 max-lg:min-h-11">
            <LogOut aria-hidden="true" />
            Logout
          </Button>
        </Card>

        {!loading && trendPoints.length > 0 && <ScoreTrend points={trendPoints} />}

        {/* Exams List Container */}
        <Card className="student-exams-panel p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
              <ClipboardList className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-lg font-semibold tracking-tight text-slate-900">Your Assigned Examinations</h3>
              <p className="text-sm text-slate-500">Exams open here as soon as your administrator starts them.</p>
            </div>
          </div>

          {pendingSubmissionExamId && (
            <div className="student-recovery-banner" role="status">
              <div className="mb-5 flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex gap-3">
                  <CloudUpload className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden="true" />
                  <p className="leading-relaxed">
                    <strong className="font-semibold">Offline Exam Saved:</strong> You have an offline test attempt stored on this device. When online, click to synchronize your score to the server.
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={syncPendingOfflineSubmission}
                  disabled={isSyncingPending}
                  loading={isSyncingPending}
                  className="shrink-0"
                >
                  {isSyncingPending ? 'Syncing...' : <><RefreshCw aria-hidden="true" /> Sync Score Now</>}
                </Button>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" style={{ padding: '12px' }} className="mb-5 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between">
              <span className="flex items-start gap-2">
                <XCircle className="mt-0.5 size-4 shrink-0 text-red-600" aria-hidden="true" />
                <span>{error}</span>
              </span>{' '}
              <Button type="button" variant="danger-outline" size="sm" onClick={fetchExamsAndResults} className="shrink-0">
                <RefreshCw aria-hidden="true" />
                Retry dashboard
              </Button>
            </div>
          )}

          {loading ? (
            <LoadingBlock label="Loading examinations..." />
          ) : exams.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="No exams yet"
              description="No exams have been assigned to your class and section yet."
            />
          ) : (
            <div className="flex flex-col gap-6">
              {EXAM_GROUPS.map(group => {
                const groupExams = groupedExams[group.key];
                if (groupExams.length === 0) return null;
                const headingId = `student-exam-group-${group.key}`;
                return (
                  <section key={group.key} aria-labelledby={headingId} className="flex flex-col gap-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <h4 id={headingId} className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
                        <group.icon className={cn('size-4', group.iconTone)} aria-hidden="true" />
                        {group.title}
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold normal-case tracking-normal text-slate-600 tabular-nums">{groupExams.length}</span>
                      </h4>
                      <p className="hidden text-xs text-slate-500 sm:block">{group.hint}</p>
                    </div>
                    <div className={cn('flex flex-col gap-3 *:flex *:flex-col *:gap-4 *:rounded-xl *:border *:bg-white', group.cardBorder, '*:p-5 *:transition-shadow *:hover:shadow-card sm:*:flex-row sm:*:items-center sm:*:justify-between')}>
                      {groupExams.map(exam => {
                        const isCompleted = completedExams.has(exam.id);
                        const isEnding = !isCompleted && exam.id === endingExamId;
                        const isActive = exam.status === 'ACTIVE';
                        const isPending = exam.status === 'PENDING';
                        const isEnded = exam.status === 'ENDED';
                        const isResumable = activeLocalSession?.activeExam?.id === exam.id;
                        const result = completedResults[exam.id];
                        const percent = result ? scorePercent(result) : null;

                        return (
                          <div className="student-exam-card" key={exam.id} data-exam-group={group.key}>
                            <div className="min-w-0">
                              <div className="mb-2 flex flex-wrap items-center gap-2">
                                <h5 className="min-w-0 break-words text-base font-semibold text-slate-900">{exam.title}</h5>
                                {isCompleted ? (
                                  <Badge variant="success"><CheckCircle2 aria-hidden="true" /> Completed</Badge>
                                ) : isEnding ? (
                                  <Badge variant="warning"><CloudUpload aria-hidden="true" /> Ended, result pending</Badge>
                                ) : isEnded ? (
                                  <Badge variant="neutral"><CircleStop aria-hidden="true" /> Ended</Badge>
                                ) : isPending ? (
                                  <Badge variant="warning"><Hourglass aria-hidden="true" /> Not started</Badge>
                                ) : isActive ? (
                                  <Badge variant="brand"><span className="size-1.5 rounded-full bg-brand-600" aria-hidden="true" /> {isResumable ? 'In progress' : 'Live'}</Badge>
                                ) : null}
                              </div>
                              <div className="student-exam-meta flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-500">
                                <span className="inline-flex items-center gap-1.5"><Clock className="size-4 text-slate-400" aria-hidden="true" /> {exam.questionsData?.duration || 180} Minutes</span>
                                {/** @type {number} */ (exam.questionsData?.subjects?.length) > 0 && (
                                  <span className="inline-flex items-center gap-1.5"><BookOpen className="size-4 text-slate-400" aria-hidden="true" /> {/** @type {{ subjects: string[] }} */ (exam.questionsData).subjects.join(', ')}</span>
                                )}
                                {isCompleted && result && (
                                  <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 tabular-nums">
                                    <BarChart3 className="size-4 text-slate-400" aria-hidden="true" /> Score {result.totalScore} / {result.maxScore}{percent !== null ? ` (${formatPercent(percent)})` : ''}
                                  </span>
                                )}
                              </div>
                              {isEnding && (
                                <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-slate-600">
                                  <CloudUpload className="size-4 shrink-0 text-amber-600" aria-hidden="true" /> This attempt was ended. Your result will appear once it reaches the exam server.
                                </p>
                              )}
                              {!isCompleted && !isEnding && isActive && isResumable && (
                                <AttemptCountdown endTime={/** @type {number} */ (activeLocalSession?.endTime)} />
                              )}
                              {!isCompleted && isPending && (
                                <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-slate-600">
                                  <Hourglass className="size-4 shrink-0 text-amber-600" aria-hidden="true" /> Starts when your administrator opens it.
                                </p>
                              )}
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              {isCompleted ? (
                                result && onViewResult && (
                                  <Button
                                    variant="secondary"
                                    className="max-lg:min-h-11"
                                    onClick={() => onViewResult(result)}
                                  >
                                    <BarChart3 aria-hidden="true" /> View Scorecard
                                  </Button>
                                )
                              ) : isEnding ? null : isEnded ? (
                                <span className="text-sm text-slate-500">This exam has ended.</span>
                              ) : isActive ? (
                                <Button
                                  variant={isResumable ? 'primary' : 'success'}
                                  className="max-lg:min-h-11"
                                  onClick={() => handleStartExam(exam)}
                                >
                                  {isResumable ? <><RotateCcw aria-hidden="true" /> Resume Exam</> : <><Play aria-hidden="true" /> Start Exam</>}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export default StudentDashboard;
