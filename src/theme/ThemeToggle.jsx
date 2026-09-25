import { useRef } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '../components/ui/cn';
import { THEME_PREFERENCES, useTheme } from './theme';

/** @type {Record<import('./theme').ThemePreference, { label: string, icon: import('react').ElementType }>} */
export const THEME_OPTIONS = {
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
  system: { label: 'System', icon: Monitor }
};

/**
 * Light / Dark / System switch as a labelled radio group (aria-checked).
 *
 * - `tone="inverse"` is for coloured bars (the exam header).
 * - `arrowKeys={false}` makes it buttons only: every option is tabbable and
 *   activated with Enter/Space or a click. The exam uses this because arrow
 *   keys there move between questions.
 * @param {{ tone?: 'default' | 'inverse', arrowKeys?: boolean, className?: string, label?: string }} props
 */
export default function ThemeToggle({ tone = 'default', arrowKeys = true, className, label = 'Colour theme' }) {
  const { preference, setPreference } = useTheme();
  const buttonRefs = useRef(/** @type {Record<string, HTMLButtonElement | null>} */ ({}));

  /** @param {import('react').KeyboardEvent<HTMLButtonElement>} event */
  const handleKeyDown = (event) => {
    if (!arrowKeys) return;
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const index = THEME_PREFERENCES.indexOf(preference);
    const next = THEME_PREFERENCES[(index + step + THEME_PREFERENCES.length) % THEME_PREFERENCES.length];
    setPreference(next);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'theme-toggle inline-flex shrink-0 items-center gap-0.5 rounded-full p-1',
        tone === 'inverse' ? 'bg-white/10 ring-1 ring-white/15' : 'bg-slate-100 ring-1 ring-slate-200',
        className
      )}
    >
      {THEME_PREFERENCES.map((value) => {
        const { label: optionLabel, icon: Icon } = THEME_OPTIONS[value];
        const checked = preference === value;
        return (
          <button
            key={value}
            ref={(node) => { buttonRefs.current[value] = node; }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={optionLabel}
            title={`${optionLabel} theme`}
            tabIndex={arrowKeys && !checked ? -1 : 0}
            onClick={() => setPreference(value)}
            onKeyDown={handleKeyDown}
            className={cn(
              'grid size-8 place-items-center rounded-full p-0 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 max-[900px]:size-11',
              tone === 'inverse'
                ? cn('focus-visible:outline-white', checked ? 'bg-white text-brand-700 shadow-sm' : 'text-brand-50 hover:bg-white/15')
                : cn('focus-visible:outline-brand-600', checked ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:text-slate-900')
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
