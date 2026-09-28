import MathRenderer from './MathRenderer';
import { MATCH_LEFT_LABELS, MATCH_RIGHT_LABELS } from '../questionTypes';
import { cn } from './ui';

/**
 * Matrix-match List-I (P, Q, ...) and List-II (1, 2, ...) side by side, as
 * candidates see them.
 * @param {{ lists: import('../types').MatchLists, className?: string }} props
 */
export default function MatchListsTable({ lists, className }) {
  const rows = Math.max(lists.left.length, lists.right.length);
  return (
    <table className={cn('w-full border-collapse text-left', className)}>
      <caption className="mb-1.5 text-left text-sm font-semibold text-slate-700">List-I and List-II</caption>
      <thead className="bg-slate-100 text-slate-700">
        <tr>
          <th scope="col" className="border border-slate-200 px-3 py-2 font-semibold">List-I</th>
          <th scope="col" className="border border-slate-200 px-3 py-2 font-semibold">List-II</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row} className="align-top">
            {[{ items: lists.left, labels: MATCH_LEFT_LABELS }, { items: lists.right, labels: MATCH_RIGHT_LABELS }].map(({ items, labels }, column) => (
              <td key={column} className="border border-slate-200 px-3 py-2 text-slate-800">
                {items[row] !== undefined && (
                  <span className="flex gap-2 whitespace-pre-wrap break-words">
                    <strong className="shrink-0">{labels[row]}.</strong>
                    <span className="min-w-0">{items[row] ? <MathRenderer text={items[row]} /> : <em className="text-slate-400">empty</em>}</span>
                  </span>
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
