import { AlertTriangle, CheckCircle2, Layers, ListChecks, Loader2 } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, cn } from '../../../components/ui';
import { countBySubject, evaluatePatternSelection, validateExamSettings } from '../../../examPatternLogic';
import { useAdminContext } from '../adminContext';
import { MAX_EXAM_QUESTIONS } from '../adminConstants';

/**
 * Sticky "Create Exam" card beside the Question Bank, with the live F1 pattern check.
 * @param {{
 *   examBuilder: import('./useExamBuilder').ExamBuilder,
 *   selectedQuestions: string[],
 *   knownQuestionSubjects: Record<string, string>
 * }} props
 */
export default function CreateExamCard({ examBuilder, selectedQuestions, knownQuestionSubjects }) {
  const { classes } = useAdminContext().classBook;
  const {
    newExamTitle,
    setNewExamTitle,
    isCreatingExam,
    examDuration,
    setExamDuration,
    examMarksCorrect,
    setExamMarksCorrect,
    examMarksIncorrect,
    setExamMarksIncorrect,
    examTargetClass,
    setExamTargetClass,
    examTargetSection,
    setExamTargetSection,
    selectedTemplateId,
    selectedTemplate,
    usableTemplates,
    selectTemplate,
    handleCreateExamFromSelected
  } = examBuilder;

  const patternCheck = selectedTemplate
    ? evaluatePatternSelection(/** @type {import('../../../types').PatternTemplate} */ (selectedTemplate), countBySubject(selectedQuestions.map(id => knownQuestionSubjects[id])))
    : null;
  const settingsProblems = validateExamSettings({ duration: examDuration, marksCorrect: examMarksCorrect, marksIncorrect: examMarksIncorrect });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle><ListChecks aria-hidden="true" /> Create Exam</CardTitle>
          <CardDescription>
            Selected Questions: <strong className="text-slate-900 tabular-nums">{selectedQuestions.length}</strong> / {MAX_EXAM_QUESTIONS}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field label="Exam title" htmlFor="new-exam-title">
          <Input
            id="new-exam-title"
            type="text"
            placeholder="Exam Title (e.g. Midterms)"
            value={newExamTitle}
            onChange={(e) => setNewExamTitle(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Class" htmlFor="new-exam-class">
            <Select
              id="new-exam-class"
              aria-label="Target class for new exam"
              value={examTargetClass}
              onChange={e => {
                setExamTargetClass(e.target.value);
                const cls = classes.find(c => c.name === e.target.value);
                setExamTargetSection(cls && cls.sections && cls.sections.length > 0 ? cls.sections[0] : '');
              }}
            >
              <option value="">Select Target Class...</option>
              {classes.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </Select>
          </Field>

          <Field label="Section" htmlFor="new-exam-section">
            <Select
              id="new-exam-section"
              aria-label="Target section for new exam"
              value={examTargetSection}
              disabled={!examTargetClass}
              onChange={e => setExamTargetSection(e.target.value)}
            >
              <option value="">Select Target Section...</option>
              {examTargetClass &&
                (classes.find(c => c.name === examTargetClass)?.sections || []).map(sec => (
                  <option key={sec} value={sec}>{sec}</option>
                ))
              }
            </Select>
          </Field>
        </div>

        <Field
          label="Exam pattern"
          htmlFor="new-exam-pattern"
          hint={selectedTemplate ? 'Duration and marking come from the pattern.' : 'Choose a pattern to pre-fill structure and marking, or build a custom exam.'}
        >
          <Select
            id="new-exam-pattern"
            aria-label="Exam pattern for new exam"
            value={selectedTemplate ? selectedTemplateId : ''}
            onChange={event => selectTemplate(event.target.value)}
          >
            <option value="">Custom (no pattern)</option>
            {usableTemplates.map(template => (
              <option key={template.id} value={template.id}>
                {template.name} · {template.totalQuestions} Qs · {template.durationMinutes} min
              </option>
            ))}
          </Select>
        </Field>

        {selectedTemplate && (
          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3" aria-live="polite">
            <p className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
              <span>Pattern check</span>
              {patternCheck?.ok
                ? <Badge variant="success"><CheckCircle2 aria-hidden="true" /> Matches</Badge>
                : <Badge variant="warning"><AlertTriangle aria-hidden="true" /> Not yet</Badge>}
            </p>
            <ul className="flex flex-col gap-1.5 text-sm">
              {patternCheck?.rows.map(row => (
                <li key={row.subject} className="flex items-center justify-between gap-2">
                  <span className="text-slate-700">{row.subject}</span>
                  <span className={cn('tabular-nums font-semibold',
                    row.status === 'ok' ? 'text-emerald-700' : row.status === 'short' ? 'text-amber-700' : 'text-red-700')}>
                    {row.selected} / {row.required}
                  </span>
                </li>
              ))}
              {patternCheck?.extras.map(extra => (
                <li key={extra.subject} className="flex items-center justify-between gap-2 text-red-700">
                  <span>{extra.subject} (not in pattern)</span>
                  <span className="tabular-nums font-semibold">{extra.selected}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <Field label="Duration (minutes)" htmlFor="new-exam-duration">
          <Input
            id="new-exam-duration"
            aria-label="Duration for new exam"
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            step={1}
            value={examDuration}
            disabled={Boolean(selectedTemplate)}
            onChange={e => setExamDuration(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Correct" htmlFor="new-exam-marks-correct">
            <Input
              id="new-exam-marks-correct"
              aria-label="Marks for a correct answer"
              type="number"
              min={0.25}
              max={100}
              step={0.25}
              value={examMarksCorrect}
              disabled={Boolean(selectedTemplate)}
              onChange={e => setExamMarksCorrect(e.target.value)}
            />
          </Field>

          <Field label="Incorrect" htmlFor="new-exam-marks-incorrect">
            <Input
              id="new-exam-marks-incorrect"
              aria-label="Marks for an incorrect answer"
              type="number"
              min={-100}
              max={0}
              step={0.25}
              value={examMarksIncorrect}
              disabled={Boolean(selectedTemplate)}
              onChange={e => setExamMarksIncorrect(e.target.value)}
            />
          </Field>
        </div>
        {settingsProblems.length > 0 && (
          <Alert variant="danger" role="alert">{settingsProblems[0]}</Alert>
        )}

        {selectedTemplate && patternCheck && !patternCheck.ok && selectedQuestions.length > 0 && (
          <p className="text-xs text-amber-800" role="status">{patternCheck.problems[0]}</p>
        )}
        <Button variant="success" size="lg" className="w-full text-sm" onClick={handleCreateExamFromSelected} disabled={selectedQuestions.length === 0 || selectedQuestions.length > MAX_EXAM_QUESTIONS || isCreatingExam || settingsProblems.length > 0 || Boolean(selectedTemplate && patternCheck && !patternCheck.ok)}>
          {isCreatingExam ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Layers aria-hidden="true" />}
          {isCreatingExam ? 'Creating…' : 'Create Exam'}
        </Button>
      </CardContent>
    </Card>
  );
}
