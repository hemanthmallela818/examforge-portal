import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and resolve conflicting Tailwind utilities.
 * @param {...import('clsx').ClassValue} inputs
 * @returns {string}
 */
export const cn = (...inputs) => twMerge(clsx(inputs));
