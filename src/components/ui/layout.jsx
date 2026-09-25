import { cn } from './cn';

/**
 * Section heading with optional description and right-aligned actions.
 * @param {{ icon?: import('react').ElementType, title: import('react').ReactNode, description?: import('react').ReactNode, actions?: import('react').ReactNode, as?: import('react').ElementType, id?: string, className?: string }} props
 */
export const SectionHeader = ({ icon: Icon, title, description, actions, as: Tag = 'h2', id, className }) => (
  <div className={cn('flex flex-wrap items-start justify-between gap-4', className)}>
    <div className="flex min-w-0 items-start gap-3">
      {Icon && (
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
          <Icon className="size-5" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0">
        <Tag id={id} className="text-lg font-semibold tracking-tight text-slate-900">{title}</Tag>
        {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
      </div>
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);

/** @typedef {'brand' | 'success' | 'warning' | 'danger' | 'violet' | 'neutral'} StatTone */

/**
 * KPI tile for dashboards.
 * @param {{ icon?: import('react').ElementType, label: import('react').ReactNode, value: import('react').ReactNode, hint?: import('react').ReactNode, tone?: StatTone, className?: string }} props
 */
export const StatCard = ({ icon: Icon, label, value, hint, tone = 'brand', className }) => {
  /** @type {Record<StatTone, string>} */
  const tones = {
    brand: 'bg-brand-50 text-brand-600 ring-brand-100',
    success: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
    warning: 'bg-amber-50 text-amber-600 ring-amber-100',
    danger: 'bg-red-50 text-red-600 ring-red-100',
    violet: 'bg-violet-50 text-violet-600 ring-violet-100',
    neutral: 'bg-slate-100 text-slate-600 ring-slate-200'
  };
  return (
    <div className={cn('flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-card', className)}>
      {Icon && (
        <div className={cn('grid size-11 shrink-0 place-items-center rounded-xl ring-1', tones[tone])}>
          <Icon className="size-5" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-500">{label}</p>
        <p className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
        {hint && <p className="text-xs text-slate-400">{hint}</p>}
      </div>
    </div>
  );
};

/**
 * Label/value list used in detail panels.
 * @param {{ items: Array<{ icon?: import('react').ElementType, label: string, value: import('react').ReactNode }>, className?: string }} props
 */
export const MetaList = ({ items, className }) => (
  <dl className={cn('grid gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
    {items.map(({ icon: Icon, label, value }) => (
      <div key={label} className="flex items-start gap-2 text-sm">
        {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />}
        <dt className="text-slate-500">{label}:</dt>
        <dd className="font-medium text-slate-900">{value}</dd>
      </div>
    ))}
  </dl>
);
