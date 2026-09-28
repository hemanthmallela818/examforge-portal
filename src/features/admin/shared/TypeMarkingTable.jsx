import { useId } from 'react';
import { Input } from '../../../components/ui';
import { questionTypeInfo } from '../../../questionTypes';

/**
 * Optional marks per question type. A blank field uses the exam-wide marks
 * (shown as the placeholder); multiple correct can switch partial marks off.
 * Emits a marking object containing only what the administrator set.
 * @param {{
 *   types: readonly string[],
 *   marking: import('../../../types').ExamMarking | null | undefined,
 *   defaults: { correct: unknown, incorrect: unknown },
 *   onChange: (marking: import('../../../types').ExamMarking) => void,
 *   locked?: boolean
 * }} props
 */
export default function TypeMarkingTable({ types, marking, defaults, onChange, locked = false }) {
  const idPrefix = useId();
  const current = marking || {};
  // Types that still hold values stay visible, so a value can always be fixed.
  const rows = [...new Set([...types, ...Object.keys(current)].flatMap(type => questionTypeInfo(type)?.code || []))];
  if (rows.length === 0) return null;

  /**
   * @param {string} code
   * @param {'correct' | 'incorrect' | 'partial'} field
   * @param {number | boolean | undefined} value undefined removes the field.
   */
  const setField = (code, field, value) => {
    const entry = { ...(current[/** @type {import('../../../types').QuestionTypeCode} */ (code)] || {}) };
    if (value === undefined) delete entry[field];
    else /** @type {Record<string, unknown>} */ (entry)[field] = value;
    const next = { ...current, [code]: entry };
    if (Object.keys(entry).length === 0) delete next[/** @type {import('../../../types').QuestionTypeCode} */ (code)];
    onChange(next);
  };

  return (
    <fieldset className="rounded-xl border border-slate-200 p-3" disabled={locked}>
      <legend className="px-1 text-sm font-semibold text-slate-800">Marking by question type</legend>
      <p className="mb-2 text-xs text-slate-500">Leave a field blank to use the exam-wide marks.</p>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-slate-500">
            <th scope="col" className="pb-1 font-medium">Type</th>
            <th scope="col" className="pb-1 font-medium">Correct</th>
            <th scope="col" className="pb-1 font-medium">Wrong</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(code => {
            const info = /** @type {import('../../../types').QuestionTypeInfo} */ (questionTypeInfo(code));
            const entry = current[info.code] || {};
            return (
              <tr key={code} className="align-top">
                <th scope="row" className="py-1 pr-2 font-medium text-slate-700">
                  {info.label}
                  {info.code === 'MULTIPLE_CORRECT' && (
                    <label className="mt-1 flex items-center gap-1.5 text-xs font-normal text-slate-600">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-brand-600"
                        checked={entry.partial !== false}
                        onChange={(e) => setField(code, 'partial', e.target.checked ? undefined : false)}
                      />
                      Partial marks
                    </label>
                  )}
                </th>
                {/** @type {const} */ (['correct', 'incorrect']).map(field => (
                  <td key={field} className="py-1 pr-2">
                    <Input
                      id={`${idPrefix}-${code}-${field}`}
                      aria-label={`${info.label}: marks for a ${field === 'correct' ? 'correct' : 'wrong'} answer`}
                      type="number"
                      step={0.25}
                      min={field === 'correct' ? 0.25 : -100}
                      max={field === 'correct' ? 100 : 0}
                      placeholder={String(field === 'correct' ? defaults.correct : defaults.incorrect)}
                      value={entry[field] ?? ''}
                      onChange={(e) => setField(code, field, e.target.value === '' ? undefined : Number(e.target.value))}
                      className="h-8 w-20 px-2 tabular-nums"
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </fieldset>
  );
}
