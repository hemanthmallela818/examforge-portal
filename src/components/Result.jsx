import { ArrowLeft, BarChart3, CheckCircle2, CircleSlash, Trophy, XCircle } from 'lucide-react';
import { Button, StatCard } from './ui';

/**
 * @param {{
 *   results: import('../features/exam/examSessionHelpers').Scorecard | null,
 *   onBackToDashboard: () => void
 * }} props
 */
const Result = ({ results, onBackToDashboard }) => {
  if (!results) return null;
  const { totalScore = 0, maxScore = 0, correct = 0, incorrect = 0, unattempted = 0, subjectScores = {} } = results;
  const scorePercent = maxScore > 0 ? Math.max(0, Math.min(100, (Number(totalScore) / Number(maxScore)) * 100)) : 0;
  const subjectEntries = Object.entries(subjectScores || {});
  const maxSubjectMagnitude = Math.max(1, ...subjectEntries.map(([, score]) => Math.abs(Number(score) || 0)));

  return (
    <div className="result-page flex min-h-dvh items-center justify-center bg-slate-50 px-4 py-10">
      <div className="animate-fade-in result-card w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <Trophy className="size-6" aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Exam Results</h1>
          <p className="mt-1 text-sm text-slate-500">Your server-confirmed scorecard</p>
        </div>

        {/* Main Score Box */}
        <div className="mb-6 flex justify-center">
          <div className="result-score theme-island w-full rounded-2xl bg-gradient-to-br from-brand-600 to-brand-800 px-6 py-7 text-center text-white shadow-card sm:min-w-72 sm:w-auto">
            <h2 className="text-sm font-medium uppercase tracking-wider text-brand-100">Total Score</h2>
            <div className="mt-2 text-5xl font-bold tracking-tight tabular-nums">
              {totalScore} <span className="text-2xl font-semibold text-brand-200">/ {maxScore}</span>
            </div>
            <div className="mx-auto mt-5 h-2 max-w-60 overflow-hidden rounded-full bg-white/20" aria-hidden="true">
              <div className="h-full rounded-full bg-white" style={{ width: `${scorePercent}%` }} />
            </div>
            {maxScore > 0 && (
              <p className="mt-2 text-sm font-medium text-brand-100 tabular-nums">{Math.round(scorePercent)}% of the maximum score</p>
            )}
          </div>
        </div>

        {/* Overall Stats Grid */}
        <div className="result-stats">
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard icon={CheckCircle2} tone="success" label="Correct Answers" value={correct} />
            <StatCard icon={XCircle} tone="danger" label="Incorrect Answers" value={incorrect} />
            <StatCard icon={CircleSlash} tone="neutral" label="Unattempted" value={unattempted} />
          </div>
        </div>

        {/* Subject Breakdown */}
        <h3 className="mb-3 flex items-center gap-2 border-b border-slate-100 pb-3 text-base font-semibold text-slate-900">
          <BarChart3 className="size-5 text-slate-500" aria-hidden="true" /> Subject-wise Breakdown
        </h3>
        <div className="mb-8 flex flex-col gap-2">
          {subjectEntries.map(([subject, score]) => {
            const numeric = Number(score) || 0;
            const width = (Math.abs(numeric) / maxSubjectMagnitude) * 100;
            return (
              <div key={subject} className="rounded-xl border border-slate-200 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-slate-800">{subject}</span>
                  <span className={numeric < 0 ? 'font-semibold text-red-700 tabular-nums' : 'font-semibold text-brand-700 tabular-nums'}>{score} Marks</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                  <div className={numeric < 0 ? 'h-full rounded-full bg-red-500' : 'h-full rounded-full bg-brand-500'} style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        {onBackToDashboard && (
          <div className="flex justify-center">
            <Button size="lg" onClick={onBackToDashboard} className="w-full sm:w-auto">
              <ArrowLeft aria-hidden="true" /> Return to Dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Result;
