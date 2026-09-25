import { Lock } from 'lucide-react';
import { Alert, Field, Input } from '../../../components/ui';
import { SelectionSummary } from './QuestionsStep';

/**
 * Step 3: duration and marking. Pre-filled and locked when a pattern is chosen.
 * @param {{
 *   examBuilder: import('../questions/useExamBuilder').ExamBuilder,
 *   summary: ReturnType<typeof import('./wizardLogic').summarizeSelection>,
 *   problems: string[],
 *   showErrors: boolean
 * }} props
 */
export default function MarkingStep({ examBuilder, summary, problems, showErrors }) {
  const {
    examDuration, setExamDuration, examMarksCorrect, setExamMarksCorrect, examMarksIncorrect, setExamMarksIncorrect, selectedTemplate
  } = examBuilder;
  const locked = Boolean(selectedTemplate);
  // Problems are shown live once the admin edits a value, or after Next.
  const visibleProblems = showErrors ? problems : [];

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex max-w-2xl flex-col gap-5">
        {locked && (
          <Alert variant="info" icon={Lock} title={`Set by the "${selectedTemplate?.name}" pattern`}>
            Duration and marking come from the pattern. Choose Custom (no pattern) in the Questions step to change them.
          </Alert>
        )}
        <Field label="Duration (minutes)" htmlFor="wizard-exam-duration" hint="Between 1 and 600 minutes.">
          <Input
            id="wizard-exam-duration"
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            step={1}
            value={examDuration}
            disabled={locked}
            onChange={event => setExamDuration(event.target.value)}
          />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Marks for a correct answer" htmlFor="wizard-marks-correct">
            <Input
              id="wizard-marks-correct"
              type="number"
              min={0.25}
              max={100}
              step={0.25}
              value={examMarksCorrect}
              disabled={locked}
              onChange={event => setExamMarksCorrect(event.target.value)}
            />
          </Field>
          <Field label="Marks for a wrong answer" htmlFor="wizard-marks-incorrect" hint="Zero or negative. Unanswered questions score 0.">
            <Input
              id="wizard-marks-incorrect"
              type="number"
              min={-100}
              max={0}
              step={0.25}
              value={examMarksIncorrect}
              disabled={locked}
              onChange={event => setExamMarksIncorrect(event.target.value)}
            />
          </Field>
        </div>
        {visibleProblems.length > 0 && (
          <Alert variant="danger" role="alert" id="wizard-marking-problems">
            <ul className="flex flex-col gap-0.5">
              {visibleProblems.map(problem => <li key={problem}>{problem}</li>)}
            </ul>
          </Alert>
        )}
      </div>
      <SelectionSummary summary={summary} template={selectedTemplate} />
    </div>
  );
}
