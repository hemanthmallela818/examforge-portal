import { useCallback, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from './cn';

/** @typedef {'asc' | 'desc'} SortDirection */
/** @typedef {{ key: string, direction: SortDirection }} SortState */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Compares two cell values for sorting. Empty values (null, undefined, '') always
 * sort last regardless of direction, so blanks never crowd the top of a table.
 * Strings use a locale-aware, numeric-aware, case-insensitive collation
 * ("Class 2" before "Class 10").
 * @param {unknown} a
 * @param {unknown} b
 * @param {SortDirection} direction
 */
export function compareSortValues(a, b, direction = 'asc') {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const result = typeof a === 'number' && typeof b === 'number'
    ? a - b
    : collator.compare(String(a), String(b));
  return direction === 'desc' ? -result : result;
}

/**
 * Client-side sorting for an in-memory list. The sort is stable: rows with equal
 * values keep their incoming (server) order.
 *
 * Clicking the active column toggles ascending/descending; clicking another
 * column sorts it ascending. `clearSort()` restores the incoming order.
 *
 * @template T
 * @param {T[]} items
 * @param {Record<string, (item: T) => unknown>} accessors column key -> sort value
 * @param {SortState | null} [initialSort]
 */
export function useSortableData(items, accessors, initialSort = null) {
  const [sort, setSort] = useState(/** @type {SortState | null} */ (initialSort));

  // Tables here hold at most a page of rows, so sorting on render is cheap and
  // keeps inline `accessors` objects from needing memoisation by callers.
  const accessor = sort ? accessors[sort.key] : undefined;
  const sortedItems = !sort || !accessor
    ? items
    : items
      .map((item, index) => ({ item, index, value: accessor(item) }))
      .sort((left, right) => compareSortValues(left.value, right.value, sort.direction) || left.index - right.index)
      .map(entry => entry.item);

  const requestSort = useCallback((/** @type {string} */ key) => {
    setSort(current => (current && current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: 'asc' }));
  }, []);

  const clearSort = useCallback(() => setSort(null), []);

  return { sortedItems, sort, requestSort, clearSort, setSort };
}

/**
 * `aria-sort` value for a column header.
 * @param {SortState | null | undefined} sort
 * @param {string} key
 * @returns {'ascending' | 'descending' | undefined}
 */
export function ariaSortFor(sort, key) {
  if (!sort || sort.key !== key) return undefined;
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/**
 * Sortable column header. Renders a native `<th>` carrying `aria-sort` for the
 * active column and a real `<button>` (Enter / Space, visible focus ring), so it
 * works with keyboards and screen readers without extra key handling.
 *
 * The button's accessible name is the column label; the sort state is exposed
 * through `aria-sort` on the header cell (announced by screen readers) and the
 * arrow icon.
 *
 * @param {{
 *   sortKey: string,
 *   sort: SortState | null | undefined,
 *   onSort: (key: string) => void,
 *   children: import('react').ReactNode,
 *   align?: 'left' | 'right',
 *   className?: string,
 *   buttonClassName?: string,
 *   disabled?: boolean
 * } & Omit<import('react').ThHTMLAttributes<HTMLTableCellElement>, 'children'>} props
 */
export function SortableTH({ sortKey, sort, onSort, children, align = 'left', className, buttonClassName, disabled, ...props }) {
  const direction = sort && sort.key === sortKey ? sort.direction : null;
  const Icon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ChevronsUpDown;
  return (
    <th
      scope="col"
      aria-sort={ariaSortFor(sort, sortKey)}
      className={cn(
        'h-10 whitespace-nowrap border-b border-slate-200 px-2 align-middle text-xs font-semibold uppercase tracking-wide text-slate-500',
        align === 'right' ? 'text-right' : 'text-left',
        className
      )}
      {...props}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        disabled={disabled}
        className={cn(
          'group inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 font-semibold uppercase tracking-wide transition-colors',
          'hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1',
          'disabled:cursor-not-allowed disabled:opacity-60',
          direction ? 'text-slate-900' : 'text-slate-500',
          align === 'right' && 'flex-row-reverse',
          buttonClassName
        )}
      >
        {children}
        <Icon
          className={cn('size-3.5 shrink-0', direction ? 'text-brand-600' : 'text-slate-400 group-hover:text-slate-600')}
          aria-hidden="true"
        />
      </button>
    </th>
  );
}
