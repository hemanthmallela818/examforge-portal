import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Crown, UserCog } from 'lucide-react';
import { cn } from '../../components/ui';
import { THEME_PREFERENCES, useTheme } from '../../theme/theme';
import { THEME_OPTIONS } from '../../theme/ThemeToggle';

/**
 * Role chip in the admin top bar. Opens a menu with the Light / Dark / System
 * theme choice (menuitemradio + aria-checked). Arrow keys move, Enter/Space
 * choose, Escape closes and returns focus to the chip.
 * @param {{ isRootDeveloper: boolean }} props
 */
export default function AdminProfileMenu({ isRootDeveloper }) {
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const labelId = useId();
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const triggerRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const itemRefs = useRef(/** @type {Array<HTMLButtonElement | null>} */ ([]));
  const roleLabel = isRootDeveloper ? 'Root Developer' : 'Administrator';

  useEffect(() => {
    if (!open) return undefined;
    const index = Math.max(0, THEME_PREFERENCES.indexOf(preference));
    itemRefs.current[index]?.focus();
    /** @param {PointerEvent} event */
    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(/** @type {Node} */ (event.target))) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
    // Focus the checked item only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (/** @type {boolean} */ restoreFocus) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  /** @param {import('react').KeyboardEvent<HTMLDivElement>} event */
  const handleMenuKeyDown = (event) => {
    const items = itemRefs.current.filter(Boolean);
    const index = items.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    } else if (event.key === 'Tab') {
      close(false);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      items[next]?.focus();
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title="Profile and theme"
        onClick={() => setOpen(value => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="admin-identity flex items-center gap-2.5 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-2.5 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <div className={cn('grid size-8 place-items-center rounded-full text-white', isRootDeveloper ? 'bg-violet-600' : 'bg-brand-600')}>
          {isRootDeveloper ? <Crown className="size-4" aria-hidden="true" /> : <UserCog className="size-4" aria-hidden="true" />}
        </div>
        <span className="text-sm font-semibold text-slate-700">{roleLabel}</span>
        <ChevronDown className={cn('size-4 text-slate-500 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={`${roleLabel} menu`}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-1.5 shadow-elevated"
        >
          <p id={labelId} className="px-2.5 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500">Theme</p>
          <div role="group" aria-labelledby={labelId}>
            {THEME_PREFERENCES.map((value, index) => {
              const { label, icon: Icon } = THEME_OPTIONS[value];
              const checked = preference === value;
              return (
                <button
                  key={value}
                  ref={(node) => { itemRefs.current[index] = node; }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  tabIndex={-1}
                  onClick={() => {
                    setPreference(value);
                    close(true);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600',
                    checked ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-100'
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{label}</span>
                  {checked && <Check className="size-4 shrink-0" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
