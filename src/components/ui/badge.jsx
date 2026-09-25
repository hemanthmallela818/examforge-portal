import { cva } from 'class-variance-authority';
import { cn } from './cn';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'border-slate-200 bg-slate-50 text-slate-600',
        brand: 'border-brand-200 bg-brand-50 text-brand-700',
        success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
        warning: 'border-amber-200 bg-amber-50 text-amber-800',
        danger: 'border-red-200 bg-red-50 text-red-700',
        violet: 'border-violet-200 bg-violet-50 text-violet-700',
        solid: 'border-transparent bg-slate-900 text-white'
      }
    },
    defaultVariants: { variant: 'neutral' }
  }
);

/**
 * @typedef {import('react').HTMLAttributes<HTMLSpanElement> & import('class-variance-authority').VariantProps<typeof badgeVariants>} BadgeProps
 */

/** @param {BadgeProps} props */
export const Badge = ({ className, variant, ...props }) => (
  <span className={cn(badgeVariants({ variant }), className)} {...props} />
);
