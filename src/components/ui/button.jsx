import { forwardRef } from 'react';
import { cva } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold transition-colors duration-150 cursor-pointer select-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        secondary: 'bg-white text-slate-800 border border-slate-200 shadow-sm hover:bg-slate-50 hover:border-slate-300',
        ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        success: 'bg-emerald-700 text-white shadow-sm hover:bg-emerald-800',
        warning: 'bg-amber-400 text-amber-950 shadow-sm hover:bg-amber-500',
        danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700',
        'danger-outline': 'bg-white text-red-700 border border-red-200 hover:bg-red-50 hover:border-red-300',
        violet: 'bg-violet-600 text-white shadow-sm hover:bg-violet-700',
        link: 'bg-transparent text-brand-700 underline-offset-4 hover:underline px-0'
      },
      size: {
        sm: 'h-8 px-3 text-xs [&_svg]:size-3.5',
        md: 'h-10 px-4 [&_svg]:size-4',
        lg: 'h-12 px-6 text-base [&_svg]:size-5',
        icon: 'size-9 p-0 [&_svg]:size-4'
      }
    },
    defaultVariants: { variant: 'primary', size: 'md' }
  }
);

/**
 * @typedef {import('react').ButtonHTMLAttributes<HTMLButtonElement>
 *   & import('class-variance-authority').VariantProps<typeof buttonVariants>
 *   & { loading?: boolean }} ButtonProps
 */

/**
 * Design-system button. `loading` shows a spinner and disables the button.
 * Always give icon-only buttons an aria-label.
 */
export const Button = forwardRef(/** @param {ButtonProps} props @param {import('react').ForwardedRef<HTMLButtonElement>} ref */ ({ className, variant, size, loading = false, disabled, children, type = 'button', ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(buttonVariants({ variant, size }), className)}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    {...props}
  >
    {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
    {children}
  </button>
));
Button.displayName = 'Button';
