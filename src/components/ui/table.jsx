import { cn } from './cn';

/**
 * Header cells stick to the top of the table's own scroll container. The bottom
 * border is drawn as an inset shadow because collapsed borders do not travel
 * with sticky cells.
 */
const stickyHeaderClass = '[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-slate-50 [&_thead_th]:shadow-[inset_0_-1px_0_var(--color-slate-200)]';

/**
 * Scrollable, bordered data table. Compose with THead/TBody/TR/TH/TD.
 *
 * `stickyHeader` caps the container height (override with `containerClassName`,
 * e.g. `max-h-[480px]`) and keeps the header row visible while the body scrolls
 * inside the container. The container is focusable only when `scrollLabel` is
 * given, so keyboard users can scroll it; the label names that region.
 * @param {import('react').TableHTMLAttributes<HTMLTableElement> & { containerClassName?: string, stickyHeader?: boolean, scrollLabel?: string }} props
 */
export const Table = ({ className, containerClassName, stickyHeader = false, scrollLabel, ...props }) => (
  <div
    className={cn(
      'w-full overflow-x-auto rounded-xl border border-slate-200 bg-white',
      stickyHeader && 'max-h-[min(70vh,44rem)] overflow-y-auto overscroll-contain',
      scrollLabel && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
      containerClassName
    )}
    {...(scrollLabel ? { role: 'region', 'aria-label': scrollLabel, tabIndex: 0 } : {})}
  >
    <table className={cn('w-full caption-bottom border-collapse text-sm', stickyHeader && stickyHeaderClass, className)} {...props} />
  </div>
);
/** @param {import('react').HTMLAttributes<HTMLTableSectionElement>} props */
export const THead = ({ className, ...props }) => <thead className={cn('bg-slate-50', className)} {...props} />;
/** @param {import('react').HTMLAttributes<HTMLTableSectionElement>} props */
export const TBody = ({ className, ...props }) => <tbody className={cn('divide-y divide-slate-100', className)} {...props} />;
/** @param {import('react').HTMLAttributes<HTMLTableRowElement>} props */
export const TR = ({ className, ...props }) => <tr className={cn('transition-colors hover:bg-slate-50/70', className)} {...props} />;
/** @param {import('react').ThHTMLAttributes<HTMLTableCellElement>} props */
export const TH = ({ className, ...props }) => (
  <th className={cn('h-10 whitespace-nowrap border-b border-slate-200 px-4 text-left align-middle text-xs font-semibold uppercase tracking-wide text-slate-500', className)} {...props} />
);
/** @param {import('react').TdHTMLAttributes<HTMLTableCellElement>} props */
export const TD = ({ className, ...props }) => <td className={cn('px-4 py-3 align-middle text-slate-700', className)} {...props} />;
