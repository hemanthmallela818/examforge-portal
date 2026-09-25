/**
 * @typedef {import('react').HTMLAttributes<HTMLElement> & { as?: import('react').ElementType }} PolymorphicProps
 * @typedef {import('react').HTMLAttributes<HTMLDivElement>} DivProps
 * @typedef {import('react').HTMLAttributes<HTMLParagraphElement>} ParagraphProps
 */
import { cn } from './cn';

/** @param {PolymorphicProps} props */
export const Card = ({ className, as: Tag = 'div', ...props }) => (
  <Tag className={cn('rounded-2xl border border-slate-200 bg-white shadow-card', className)} {...props} />
);

/** @param {DivProps} props */
export const CardHeader = ({ className, ...props }) => (
  <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-6 py-4', className)} {...props} />
);

/** @param {PolymorphicProps} props */
export const CardTitle = ({ className, as: Tag = 'h3', ...props }) => (
  <Tag className={cn('flex items-center gap-2 text-base font-semibold text-slate-900 [&_svg]:size-5 [&_svg]:text-slate-500', className)} {...props} />
);

/** @param {ParagraphProps} props */
export const CardDescription = ({ className, ...props }) => (
  <p className={cn('mt-1 text-sm text-slate-500', className)} {...props} />
);

/** @param {DivProps} props */
export const CardContent = ({ className, ...props }) => (
  <div className={cn('px-6 py-5', className)} {...props} />
);

/** @param {DivProps} props */
export const CardFooter = ({ className, ...props }) => (
  <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-6 py-4', className)} {...props} />
);
