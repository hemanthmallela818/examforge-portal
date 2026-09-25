import { Loader2 } from 'lucide-react';
import { cn } from './cn';

/** @param {{ className?: string, label?: string }} props */
export const Spinner = ({ className, label = 'Loading' }) => (
  <Loader2 className={cn('size-5 animate-spin text-brand-600', className)} role="img" aria-label={label} />
);

/**
 * Friendly empty state with icon, title, description and optional action.
 * @param {{ icon?: import('react').ElementType, title: import('react').ReactNode, description?: import('react').ReactNode, action?: import('react').ReactNode, className?: string }} props
 */
export const EmptyState = ({ icon: Icon, title, description, action, className }) => (
  <div className={cn('flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-12 text-center', className)}>
    {Icon && (
      <div className="mb-4 grid size-12 place-items-center rounded-full bg-white text-slate-400 shadow-card ring-1 ring-slate-200">
        <Icon className="size-6" aria-hidden="true" />
      </div>
    )}
    <p className="text-base font-semibold text-slate-900">{title}</p>
    {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

/**
 * Placeholder shimmer rows while data loads.
 * @param {{ className?: string }} props
 */
export const Skeleton = ({ className }) => (
  <div className={cn('animate-pulse rounded-md bg-slate-200/70', className)} aria-hidden="true" />
);

/** @param {{ label?: import('react').ReactNode, className?: string }} props */
export const LoadingBlock = ({ label = 'Loading…', className }) => (
  <div className={cn('flex items-center justify-center gap-3 py-12 text-sm text-slate-500', className)} role="status">
    <Spinner />
    <span>{label}</span>
  </div>
);
