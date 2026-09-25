import { cva } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from './cn';

const alertVariants = cva('flex gap-3 rounded-xl border px-4 py-3 text-sm leading-relaxed [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0', {
  variants: {
    variant: {
      info: 'border-brand-200 bg-brand-50 text-brand-900 [&>svg]:text-brand-600',
      success: 'border-emerald-200 bg-emerald-50 text-emerald-900 [&>svg]:text-emerald-600',
      warning: 'border-amber-200 bg-amber-50 text-amber-900 [&>svg]:text-amber-600',
      danger: 'border-red-200 bg-red-50 text-red-900 [&>svg]:text-red-600',
      neutral: 'border-slate-200 bg-slate-50 text-slate-700 [&>svg]:text-slate-500'
    }
  },
  defaultVariants: { variant: 'info' }
});

/** @typedef {'info' | 'success' | 'warning' | 'danger' | 'neutral'} AlertVariant */

/** @type {Record<AlertVariant, import('react').ElementType>} */
const ICONS = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle, neutral: Info };

/**
 * @typedef {Omit<import('react').HTMLAttributes<HTMLDivElement>, 'title'> & {
 *   variant?: AlertVariant,
 *   title?: import('react').ReactNode,
 *   action?: import('react').ReactNode,
 *   icon?: import('react').ElementType | null,
 * }} AlertProps
 */

/**
 * Inline message box. Pass `title` for a bold first line and `action` for a trailing button.
 * @param {AlertProps} props
 */
export const Alert = ({ variant = 'info', title, action, icon, className, children, ...props }) => {
  const Icon = icon ?? ICONS[variant];
  return (
    <div className={cn(alertVariants({ variant }), className)} {...props}>
      {Icon && <Icon aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5 opacity-90' : undefined}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
};
