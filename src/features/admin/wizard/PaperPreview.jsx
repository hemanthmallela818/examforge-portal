import { useState } from 'react';
import { ChevronLeft, ChevronRight, Eye } from 'lucide-react';
import QuestionPanel from '../../../components/QuestionPanel';
import { Button, cn } from '../../../components/ui';

const noop = () => {};

/**
 * Read-only "Preview as student": renders the paper with the student exam's
 * QuestionPanel (disabled; its answer and submit bar is hidden) and simple
 * subject / question navigation. Correct answers are never shown.
 * @param {{ paper: { subjects: string[], questions: Record<string, import('../../../types').ExamQuestion[]> } }} props
 */
export default function PaperPreview({ paper }) {
  const [subjectIndex, setSubjectIndex] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const subjects = paper.subjects.filter(subject => (paper.questions[subject] || []).length > 0);
  const subject = subjects[Math.min(subjectIndex, subjects.length - 1)];
  const questions = subject ? paper.questions[subject] : [];
  const index = Math.min(questionIndex, Math.max(0, questions.length - 1));
  const question = questions[index];
  const offset = subjects.slice(0, subjects.indexOf(subject)).reduce((sum, name) => sum + paper.questions[name].length, 0);
  const isFirst = subjects.indexOf(subject) === 0 && index === 0;
  const isLast = subjects.indexOf(subject) === subjects.length - 1 && index === questions.length - 1;

  const go = (/** @type {number} */ delta) => {
    const position = subjects.indexOf(subject);
    const next = index + delta;
    if (next >= 0 && next < questions.length) { setQuestionIndex(next); return; }
    const nextSubject = position + delta;
    if (nextSubject < 0 || nextSubject >= subjects.length) return;
    setSubjectIndex(nextSubject);
    setQuestionIndex(delta > 0 ? 0 : paper.questions[subjects[nextSubject]].length - 1);
  };

  if (!subject || !question) return <p className="text-sm text-slate-500">There are no questions to preview.</p>;

  return (
    <section aria-labelledby="wizard-preview-heading" className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <h4 id="wizard-preview-heading" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Eye className="size-4 text-slate-500" aria-hidden="true" /> Student view (read-only)
        </h4>
        <div role="group" aria-label="Preview subject" className="flex flex-wrap gap-1.5">
          {subjects.map((name, position) => (
            <Button
              key={name}
              size="sm"
              variant={name === subject ? 'primary' : 'secondary'}
              aria-pressed={name === subject}
              onClick={() => { setSubjectIndex(position); setQuestionIndex(0); }}
            >
              {name} <span className="tabular-nums opacity-80">({paper.questions[name].length})</span>
            </Button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 bg-white px-4 py-2.5" role="group" aria-label={`${subject} questions`}>
        {questions.map((item, position) => (
          <button
            key={item.id}
            type="button"
            aria-label={`Preview question ${offset + position + 1}`}
            aria-current={position === index ? 'true' : undefined}
            onClick={() => setQuestionIndex(position)}
            className={cn('grid size-9 place-items-center rounded-lg border text-sm font-semibold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
              position === index ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-brand-300')}
          >
            {offset + position + 1}
          </button>
        ))}
      </div>

      {/* The exam's own answer/submit bar and skip links are hidden: this is a preview, nothing can be answered. */}
      <div className="wizard-paper-preview bg-white [&_.exam-action-bar]:hidden [&_.sr-skip-nav]:hidden">
        <QuestionPanel
          question={question}
          questionIndex={offset + index}
          selectedOption={null}
          setSelectedOption={noop}
          handleAction={noop}
          goNext={noop}
          goPrev={noop}
          submitExam={noop}
          isFirstQuestionOfExam={isFirst}
          isLastQuestionOfExam={isLast}
          disabled
        />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-3">
        <Button variant="secondary" size="sm" onClick={() => go(-1)} disabled={isFirst}>
          <ChevronLeft aria-hidden="true" /> Previous question
        </Button>
        <span className="text-xs text-slate-500 tabular-nums">{subject} · {index + 1} of {questions.length}</span>
        <Button variant="secondary" size="sm" onClick={() => go(1)} disabled={isLast}>
          Next question <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
