import { Field, Input, Select } from '../../../components/ui';
import { MAX_EXAM_TITLE_LENGTH } from './wizardLogic';

/**
 * Step 1: exam title and the class / section that will write it.
 * @param {{
 *   examBuilder: import('../questions/useExamBuilder').ExamBuilder,
 *   classes: import('../../../types').ClassRow[],
 *   errors: { title?: string, targetClass?: string, targetSection?: string },
 *   showErrors: boolean,
 *   classesLoading?: boolean
 * }} props
 */
export default function DetailsStep({ examBuilder, classes, errors, showErrors, classesLoading = false }) {
  const { newExamTitle, setNewExamTitle, examTargetClass, setExamTargetClass, examTargetSection, setExamTargetSection } = examBuilder;
  const sections = classes.find(item => item.name === examTargetClass)?.sections || [];
  const visible = showErrors ? errors : {};

  return (
    <div className="grid max-w-2xl gap-5">
      <Field label="Exam title" htmlFor="wizard-exam-title" error={visible.title} hint="Students see this title on their dashboard.">
        <Input
          id="wizard-exam-title"
          data-modal-autofocus
          type="text"
          placeholder="For example: Unit Test 3 - Physics"
          maxLength={MAX_EXAM_TITLE_LENGTH}
          value={newExamTitle}
          aria-invalid={Boolean(visible.title)}
          onChange={event => setNewExamTitle(event.target.value)}
        />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Class" htmlFor="wizard-exam-class" error={visible.targetClass}>
          <Select
            id="wizard-exam-class"
            value={examTargetClass}
            aria-invalid={Boolean(visible.targetClass)}
            onChange={event => {
              setExamTargetClass(event.target.value);
              const cls = classes.find(item => item.name === event.target.value);
              setExamTargetSection(cls && cls.sections && cls.sections.length > 0 ? cls.sections[0] : '');
            }}
          >
            <option value="">Select a class…</option>
            {classes.map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label="Section" htmlFor="wizard-exam-section" error={visible.targetSection} hint={examTargetClass ? undefined : 'Choose a class first.'}>
          <Select
            id="wizard-exam-section"
            value={examTargetSection}
            disabled={!examTargetClass}
            aria-invalid={Boolean(visible.targetSection)}
            onChange={event => setExamTargetSection(event.target.value)}
          >
            <option value="">Select a section…</option>
            {sections.map(section => <option key={section} value={section}>{section}</option>)}
          </Select>
        </Field>
      </div>
      {classes.length === 0 && !classesLoading && (
        <p className="text-sm text-slate-500" role="status">No classes are available yet. Create one under Classes first.</p>
      )}
    </div>
  );
}
