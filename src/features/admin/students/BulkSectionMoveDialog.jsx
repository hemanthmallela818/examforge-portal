import { useId, useRef, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, CheckCircle2 } from 'lucide-react';
import AccessibleModal from '../../../components/AccessibleModal';
import { Alert, Button, Field, Select } from '../../../components/ui';

/**
 * Moves the selected students of one class to another section of that class.
 * Each student is updated through the trusted manage-student Edge Function
 * (audited server-side); progress and per-student failures are shown here.
 * @param {{
 *   students: import('./useStudentRoster').RosterStudent[],
 *   className: string,
 *   sections: string[],
 *   onMove: import('./useStudentRoster').StudentRoster['handleBulkSectionMove'],
 *   onClose: () => void
 * }} props
 */
export default function BulkSectionMoveDialog({ students, className, sections, onMove, onClose }) {
  const titleId = useId();
  const sectionId = useId();
  const currentSections = new Set(students.map(student => student.section).filter(Boolean));
  const [targetSection, setTargetSection] = useState(() => sections.find(section => !currentSections.has(section)) || sections[0] || '');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(/** @type {{ done: number, total: number } | null} */ (null));
  const [result, setResult] = useState(/** @type {import('./useStudentRoster').BulkMoveResult | null} */ (null));
  const [error, setError] = useState('');
  const runningRef = useRef(false);

  const startMove = async () => {
    if (runningRef.current || !targetSection) return;
    runningRef.current = true;
    setRunning(true);
    setError('');
    setResult(null);
    setProgress({ done: 0, total: students.length });
    try {
      const outcome = await onMove(students.map(student => student.docId), targetSection, setProgress);
      setResult(outcome);
    } catch (err) {
      setError(/** @type {Error} */ (err).message);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const close = () => {
    if (!runningRef.current) onClose();
  };

  const finished = Boolean(result);
  const studentCount = `${students.length} student${students.length === 1 ? '' : 's'}`;

  return (
    <AccessibleModal labelledBy={titleId} onEscape={close} maxWidth="520px">
      <div className="flex flex-col gap-4 text-left">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100">
            <ArrowRightLeft className="size-5" aria-hidden="true" />
          </div>
          <div>
            <h3 id={titleId} className="text-lg font-semibold text-slate-900">Move students to another section</h3>
            <p className="mt-0.5 text-sm text-slate-600">
              {studentCount} selected in Class {className}. Each move is applied and audited individually on the server.
            </p>
          </div>
        </div>

        <ul aria-label="Students to move" className="max-h-40 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {students.map(student => (
            <li key={student.docId} className="flex justify-between gap-3 py-0.5">
              <span className="truncate font-medium text-slate-900">{student.name}</span>
              <span className="shrink-0 text-slate-500">
                <span className="font-mono text-xs">{student.student_id || student.id}</span> · Section {student.section || 'N/A'}
              </span>
            </li>
          ))}
        </ul>

        <Field label="Target section" htmlFor={sectionId}>
          <Select
            id={sectionId}
            value={targetSection}
            disabled={running || finished}
            onChange={event => setTargetSection(event.target.value)}
          >
            {sections.map(section => <option key={section} value={section}>{section}</option>)}
          </Select>
        </Field>

        {progress && (
          <div className="flex flex-col gap-1.5">
            <progress
              aria-label="Section move progress"
              max={progress.total}
              value={progress.done}
              className="h-2 w-full overflow-hidden rounded-full accent-brand-600"
            />
            <p role="status" className="text-sm tabular-nums text-slate-600">
              {running ? `Moving… ${progress.done} of ${progress.total} processed.` : `${progress.done} of ${progress.total} processed.`}
            </p>
          </div>
        )}

        {error && <Alert variant="danger" role="alert">{error}</Alert>}

        {result && (
          <div className="flex flex-col gap-2">
            {(result.moved.length > 0 || result.unchanged.length > 0) && (
              <p className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                {result.moved.length} moved to Section {targetSection}
                {result.unchanged.length > 0 ? `, ${result.unchanged.length} already there` : ''}.
              </p>
            )}
            {result.failed.length > 0 && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                <p className="mb-1 inline-flex items-center gap-1.5 font-semibold">
                  <AlertTriangle className="size-4 text-red-600" aria-hidden="true" />
                  {result.failed.length} could not be moved. They remain selected so you can retry.
                </p>
                <ul aria-label="Failed moves" className="list-disc space-y-0.5 pl-5">
                  {result.failed.map(({ student, message }) => (
                    <li key={student.docId}>
                      <span className="font-medium">{student.name}</span> ({student.student_id || student.id}): {message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={close} disabled={running}>{finished ? 'Close' : 'Cancel'}</Button>
          {!finished && (
            <Button onClick={startMove} loading={running} disabled={!targetSection}>
              <ArrowRightLeft aria-hidden="true" /> Move {studentCount}
            </Button>
          )}
        </div>
      </div>
    </AccessibleModal>
  );
}
