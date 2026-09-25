import { Clock } from 'lucide-react';
import { Badge, Button } from '../../../components/ui';
import AccessibleModal from '../../../components/AccessibleModal';
import MathRenderer from '../../../components/MathRenderer';

/** @typedef {import('../../../types').UntrustedInput} UntrustedInput */

const formatSeconds = (/** @type {unknown} */ value) => {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
};

/**
 * @param {{ type?: unknown, options?: unknown }} question
 * @param {unknown} rawValue
 * @returns {string}
 */
const displayAnswer = (question, rawValue) => {
  if (rawValue === null || rawValue === undefined || rawValue === '') return 'Not answered';
  if (String(question.type || 'MCQ').toUpperCase() === 'NUMERICAL') return String(rawValue);
  const index = Number(rawValue);
  return Number.isInteger(index) && Array.isArray(question.options) && question.options[index] !== undefined
    ? `${String.fromCharCode(65 + index)}. ${question.options[index]}`
    : String(rawValue);
};

/**
 * Private per-student answer review (student answer vs. answer key, time per subject).
 * @param {{ review: import('./useExamDetail').StudentResultReview, onClose: () => void }} props
 */
export default function StudentAnswerReviewModal({ review: resultReview, onClose }) {
  const paper = resultReview.paper || {};
  const subjects = Array.isArray(paper.subjects) ? paper.subjects : Object.keys(paper.questions || {});
  const responseMap = resultReview.responses || {};
  const answerKey = resultReview.answer_key || {};
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
        {subjects.map((/** @type {string} */ subject) => {
          const questions = paper.questions?.[subject] || [];
          const responses = responseMap[subject] || [];
          return (
            <section key={subject} className="mb-6">
              <h3 className="mb-3 flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2 text-base font-semibold text-slate-900">
                {subject}
                <span className="inline-flex items-center gap-1 text-sm font-normal text-slate-500">
                  <Clock className="size-3.5" aria-hidden="true" /> · time {formatSeconds(resultReview.subject_time_seconds?.[subject])}
                </span>
              </h3>
              <div className="grid gap-3">
                {questions.map((/** @type {UntrustedInput} */ question, /** @type {number} */ index) => {
                  const response = responses[index] || {};
                  const selected = response.selectedOption;
                  const correct = answerKey[question.id]?.correct_answer;
                  const answered = ['ANSWERED', 'ANSWERED_MARKED'].includes(response.status) && selected !== null && selected !== undefined && selected !== '';
                  const isNumerical = ['NUMERICAL', 'NAT'].includes(String(question.type || '').toUpperCase());
                  const isCorrect = answered && (isNumerical
                    ? Math.abs(Number(selected) - Number(correct)) < 0.00001
                    : String(selected) === String(correct));
                  const outcome = !answered ? 'Unanswered' : isCorrect ? 'Correct' : 'Wrong';
                  const outcomeVariant = isCorrect ? 'success' : !answered ? 'neutral' : 'danger';
                  return (
                    <article key={question.id || `${subject}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <strong className="text-sm text-slate-900">Question {question.questionNumber || index + 1}</strong>
                        <Badge variant={outcomeVariant}>{outcome}</Badge>
                      </div>
                      <div className="text-sm text-slate-800">
                        <MathRenderer text={question.text || ''} />
                      </div>
                      <div className="mt-3 grid gap-1.5 text-sm">
                        <div><strong className="text-slate-700">Student answer:</strong> <MathRenderer text={displayAnswer(question, selected)} /></div>
                        {!isCorrect && <div><strong className="text-emerald-700">Correct answer:</strong> <MathRenderer text={displayAnswer(question, correct)} /></div>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </AccessibleModal>
  );
}
