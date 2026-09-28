import { Clock, Info } from 'lucide-react';
import { Alert, Badge, Button } from '../../../components/ui';
import AccessibleModal from '../../../components/AccessibleModal';
import MathRenderer from '../../../components/MathRenderer';
import MatchListsTable from '../../../components/MatchListsTable';
import { formatAnswer } from '../../../questionTypes';

/** @typedef {import('../../../types').UntrustedInput} UntrustedInput */

const formatSeconds = (/** @type {unknown} */ value) => {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
};

/** @type {Record<string, { label: string, variant: 'success' | 'warning' | 'danger' | 'neutral' }>} */
const OUTCOMES = {
  CORRECT: { label: 'Correct', variant: 'success' },
  PARTIAL: { label: 'Partially correct', variant: 'warning' },
  INCORRECT: { label: 'Wrong', variant: 'danger' },
  UNATTEMPTED: { label: 'Unanswered', variant: 'neutral' }
};

/** @param {unknown} marks */
const formatMarks = (marks) => {
  const value = Number(marks) || 0;
  return value > 0 ? `+${value}` : String(value);
};

/**
 * Private per-student answer review: the answers and per-question marks exactly
 * as graded (stored by the server at submission), next to the answer key.
 * @param {{ review: import('./useExamDetail').StudentResultReview, onClose: () => void }} props
 */
export default function StudentAnswerReviewModal({ review: resultReview, onClose }) {
  const paper = resultReview.paper || {};
  const subjects = Array.isArray(paper.subjects) ? paper.subjects : Object.keys(paper.questions || {});
  const responses = resultReview.responses || {};
  const scores = resultReview.question_scores || {};
  const answerKey = resultReview.answer_key || {};
  // Attempts graded before answers were stored by question ID cannot be matched
  // to the shuffled paper, so their per-question view is withheld.
  const byQuestionId = resultReview.snapshot_format === 'by_question_id';

  return (
    <AccessibleModal labelledBy="student-answer-review-title" onEscape={onClose} maxWidth="1000px">
      <div className="text-left">
        <div className="mb-5 flex items-start justify-between gap-5 border-b border-slate-100 pb-4">
          <div>
            <h2 id="student-answer-review-title" className="text-lg font-semibold tracking-tight text-slate-900">Student answer review</h2>
            <p className="mt-1 text-sm text-slate-500">{resultReview.studentName} · <span className="font-mono">{resultReview.student_id}</span></p>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
        {!byQuestionId && (
          <Alert variant="info" icon={Info} className="mb-5">
            Per-question review is unavailable for attempts submitted before this update: their question order was not recorded. Subject times are shown below.
          </Alert>
        )}
        {subjects.map((/** @type {string} */ subject) => {
          const questions = paper.questions?.[subject] || [];
          return (
            <section key={subject} className="mb-6">
              <h3 className="mb-3 flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2 text-base font-semibold text-slate-900">
                {subject}
                <span className="inline-flex items-center gap-1 text-sm font-normal text-slate-500">
                  <Clock className="size-3.5" aria-hidden="true" /> · time {formatSeconds(resultReview.subject_time_seconds?.[subject])}
                </span>
              </h3>
              {byQuestionId && (
                <div className="grid gap-3">
                  {questions.map((/** @type {UntrustedInput} */ question, /** @type {number} */ index) => {
                    const selected = responses[question.id]?.selected_option;
                    const correct = answerKey[question.id]?.correct_answer;
                    const score = scores[question.id] || { outcome: 'UNATTEMPTED', marks: 0 };
                    const outcome = OUTCOMES[score.outcome] || OUTCOMES.UNATTEMPTED;
                    return (
                      <article key={question.id || `${subject}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <strong className="text-sm text-slate-900">Question {question.questionNumber || index + 1}</strong>
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-semibold tabular-nums text-slate-700">{formatMarks(score.marks)}</span>
                            <Badge variant={outcome.variant}>{outcome.label}</Badge>
                          </span>
                        </div>
                        {question.details?.passage?.text && (
                          <details className="mb-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                            <summary className="cursor-pointer font-medium">Paragraph</summary>
                            <p className="mt-1 whitespace-pre-wrap"><MathRenderer text={question.details.passage.text} /></p>
                          </details>
                        )}
                        <div className="text-sm text-slate-800">
                          <MathRenderer text={question.text || ''} />
                        </div>
                        {question.details?.matchLists && <MatchListsTable lists={question.details.matchLists} className="mt-2 bg-white text-sm" />}
                        <div className="mt-3 grid gap-1.5 text-sm">
                          <div><strong className="text-slate-700">Student answer:</strong> <MathRenderer text={formatAnswer(question, selected) || 'Not answered'} /></div>
                          {score.outcome !== 'CORRECT' && (
                            <div><strong className="text-emerald-700">Correct answer:</strong> <MathRenderer text={formatAnswer(question, correct) || 'Not answered'} /></div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </AccessibleModal>
  );
}
