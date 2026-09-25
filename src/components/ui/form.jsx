import { forwardRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';

const fieldBase = 'w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-brand-500 focus:outline-none focus:ring-4 focus:ring-brand-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 aria-[invalid=true]:border-red-400 aria-[invalid=true]:focus:ring-red-100';

export const Input = forwardRef(/** @param {import('react').InputHTMLAttributes<HTMLInputElement>} props @param {import('react').ForwardedRef<HTMLInputElement>} ref */ ({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldBase, 'h-10', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef(/** @param {import('react').TextareaHTMLAttributes<HTMLTextAreaElement>} props @param {import('react').ForwardedRef<HTMLTextAreaElement>} ref */ ({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldBase, 'min-h-24 py-2 leading-relaxed', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef(/** @param {import('react').SelectHTMLAttributes<HTMLSelectElement>} props @param {import('react').ForwardedRef<HTMLSelectElement>} ref */ ({ className, children, ...props }, ref) => (
  <div className="relative">
    <select ref={ref} className={cn(fieldBase, 'h-10 appearance-none pr-9', className)} {...props}>
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
  </div>
));
Select.displayName = 'Select';

/** @param {import('react').LabelHTMLAttributes<HTMLLabelElement>} props */
export const Label = ({ className, ...props }) => (
  <label className={cn('text-sm font-medium text-slate-700', className)} {...props} />
);

/**
 * Label + control + optional hint/error, stacked with consistent spacing.
 * @param {{ label?: import('react').ReactNode, htmlFor?: string, hint?: import('react').ReactNode, error?: import('react').ReactNode, className?: string, children?: import('react').ReactNode }} props
 */
export const Field = ({ label, htmlFor, hint, error, className, children }) => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    {label && <Label htmlFor={htmlFor}>{label}</Label>}
    {children}
    {error ? (
      <p className="text-xs font-medium text-red-600" role="alert">{error}</p>
    ) : hint ? (
      <p className="text-xs text-slate-500">{hint}</p>
    ) : null}
  </div>
);

export const Checkbox = forwardRef(/** @param {Omit<import('react').InputHTMLAttributes<HTMLInputElement>, 'type'>} props @param {import('react').ForwardedRef<HTMLInputElement>} ref */ ({ className, ...props }, ref) => (
  <input ref={ref} type="checkbox" className={cn('size-4 cursor-pointer rounded border-slate-300 accent-brand-600', className)} {...props} />
));
Checkbox.displayName = 'Checkbox';
