import React from 'react';
import { Activity, AlertTriangle, ArrowLeft, BarChart3, BookOpen, Clock, Hash, Play, Scale, School, SearchCheck, Shapes, Square, Trash2, Trophy } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, LoadingBlock, MetaList, StatCard } from '../../../components/ui';
import ExamQuestionsArchive from '../../../components/ExamQuestionsArchive';
import { useAdminContext } from '../adminContext';
import { ExamStatusBadge } from '../shared/AdminUi';
import ExamLeaderboard from './ExamLeaderboard';
import StudentAnswerReviewModal from './StudentAnswerReviewModal';

const AdminAnalyticsCharts = React.lazy(() => import('../../../components/AdminAnalyticsCharts'));

/**
 * @typedef {object} ExamDetailViewProps
 * @property {ReturnType<typeof import('./useExamDetail').useExamDetail>} examDetail
 * @property {ReturnType<typeof import('./useResultExports').useResultExports>} resultExports
 * @property {ReturnType<typeof import('./useExamActions').useExamActions>} examActions
 * @property {() => void} onBack
 */

/**
 * Exam Management: record, lifecycle controls, analytics, archive, leaderboard and answer review.
 * @param {ExamDetailViewProps} props
 */
export default function ExamDetailView({ examDetail, resultExports, examActions, onBack }) {
  const { dataLoadState } = useAdminContext();
  const { activeExamId, activeExamDetail, resultAnalytics, resultReview, setResultReview, fetchExamDetail } = examDetail;
  const { handlePreflightCheck, toggleExamStatus, handleDeleteExam } = examActions;

  const exam = activeExamDetail;
  if (!exam) {
    const detailState = /** @type {Partial<import('../../../types').DataLoadEntry>} */ (dataLoadState.examDetail || {});
    return (
      <Card className="animate-fade-in">
        <CardContent className="flex flex-col gap-5">
          <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={onBack}>
            <ArrowLeft aria-hidden="true" /> Back to All Exams
          </Button>
          {detailState.error ? (
            <Alert
              variant="danger"
              role="alert"
              title="Examination details could not be loaded"
              action={<Button size="sm" onClick={() => fetchExamDetail(/** @type {string} */ (activeExamId))}>Retry exam details</Button>}
            >
              {detailState.error}
            </Alert>
          ) : (
            <LoadingBlock label="Loading the complete examination record…" />
          )}
        </CardContent>
      </Card>
    );
  }

  const analytics = resultAnalytics;
  const totalQuestionCount = exam.questionsData?.questions ? Object.values(exam.questionsData.questions).reduce((sum, list) => sum + list.length, 0) : 0;
  return (
    <div className="animate-fade-in flex h-full flex-col gap-6">
      <Button variant="ghost" size="sm" className="-ml-2 self-start" onClick={onBack}>
        <ArrowLeft aria-hidden="true" /> Back to All Exams
      </Button>

      {/* Top Widgets for this Exam */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* Exam Details Widget */}
        <Card>
          <CardHeader>
            <h2 className="min-w-0 break-words text-xl font-semibold tracking-tight text-slate-900">{exam.title}</h2>
          </CardHeader>
          <CardContent>
            <MetaList
              items={[
                { icon: School, label: 'Target Audience', value: `${exam.class} - ${exam.section}` },
                { icon: Clock, label: 'Duration', value: `${exam.questionsData?.duration || 180} Minutes` },
                { icon: Scale, label: 'Grading', value: `+${exam.questionsData?.marksCorrect || 4} / ${exam.questionsData?.marksIncorrect || -1}` },
                { icon: Hash, label: 'Total Questions', value: `${totalQuestionCount} Questions` },
                { icon: BookOpen, label: 'Subjects', value: exam.questionsData?.subjects?.join(', ') || 'Not recorded' },
                ...(exam.questionsData?.pattern?.name ? [{ icon: Shapes, label: 'Pattern', value: exam.questionsData.pattern.name }] : [])
              ]}
            />
          </CardContent>
        </Card>

        {/* Exam Control Widget */}
        <Card className="flex flex-col">
          <CardContent className="flex flex-1 flex-col items-center justify-between gap-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Exam Status</p>
              <ExamStatusBadge status={exam.status} size="lg" />
            </div>
            <div className="flex w-full flex-wrap gap-2">
              <Button
                variant="secondary"
                size="lg"
                className="text-sm"
                onClick={() => handlePreflightCheck(exam.id)}
                title="Run Preflight Validation"
              >
                <SearchCheck aria-hidden="true" /> Preflight
              </Button>
              <Button
                variant={exam.status === 'ACTIVE' ? 'danger' : 'success'}
                size="lg"
                className="min-w-[140px] flex-1"
                onClick={() => toggleExamStatus(exam.id)}
              >
                {exam.status === 'ACTIVE' ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
                {exam.status === 'ACTIVE' ? 'End Exam' : 'Start Exam'}
              </Button>
              <Button
                variant="danger-outline"
                size="icon"
                className="size-12"
                onClick={() => handleDeleteExam(exam.id)}
                aria-label="Delete Exam"
                title="Delete Exam"
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {analytics && (
        <Card>
          <CardHeader>
            <CardTitle><BarChart3 aria-hidden="true" /> Analytics & Insights</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard icon={Activity} label="Average Score" value={analytics.averageScore.toFixed(1)} tone="brand" />
              <StatCard icon={Trophy} label="Highest Score" value={analytics.highestScore} tone="success" />
              <StatCard icon={AlertTriangle} label="Lowest Score" value={analytics.lowestScore} tone="danger" />
            </div>

            <React.Suspense fallback={<LoadingBlock label="Loading analytics charts…" />}>
              <AdminAnalyticsCharts distribution={analytics.distribution} subjectAverages={analytics.subjectAverages} />
            </React.Suspense>
            {analytics.excludedFromDistribution > 0 && (
              <Alert variant="warning" role="alert">
                {analytics.excludedFromDistribution} result(s) were excluded from percentage distribution because their maximum score is zero or invalid.
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Exam Question Paper Archive */}
      <ExamQuestionsArchive exam={exam} />

      {/* Leaderboard Section */}
      <ExamLeaderboard exam={exam} examDetail={examDetail} resultExports={resultExports} />

      {resultReview && (
        <StudentAnswerReviewModal review={resultReview} onClose={() => setResultReview(null)} />
      )}
    </div>
  );
}
