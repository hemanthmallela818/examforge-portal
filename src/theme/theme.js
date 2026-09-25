// Colour theme (U3): Light, Dark or System, persisted per browser.
//
// The resolved theme is applied as a `dark` class (plus data-theme and
// color-scheme) on <html>; src/index.css remaps the Tailwind colour variables
// under `.dark`, so existing utility classes render dark without per-component
// changes. initTheme() runs in main.jsx before React renders (no inline script,
// compatible with `script-src 'self'`), and "System" follows
// prefers-color-scheme live.
import { useSyncExternalStore } from 'react';
import { safeStorageGet, safeStorageSet } from '../browserStorage.js';

export const THEME_STORAGE_KEY = 'examforge.theme';
/** @typedef {'light' | 'dark' | 'system'} ThemePreference */
/** @typedef {'light' | 'dark'} ResolvedTheme */

/** @type {ReadonlyArray<ThemePreference>} */
export const THEME_PREFERENCES = Object.freeze(['light', 'dark', 'system']);
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * @param {unknown} value
 * @returns {ThemePreference}
 */
export function normalizeThemePreference(value) {
  return THEME_PREFERENCES.includes(/** @type {ThemePreference} */ (value)) ? /** @type {ThemePreference} */ (value) : 'system';
}

/**
 * @param {ThemePreference} preference
 * @param {boolean} systemPrefersDark
 * @returns {ResolvedTheme}
 */
export function resolveTheme(preference, systemPrefersDark) {
  if (preference === 'light' || preference === 'dark') return preference;
  return systemPrefersDark ? 'dark' : 'light';
}

/** @returns {MediaQueryList | null} */
const darkQuery = () => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  } catch {
    return null;
  }
};

/**
 * Applies a resolved theme to the document root.
 * @param {ResolvedTheme} resolved
 * @param {Document | undefined} [doc]
 */
export function applyResolvedTheme(resolved, doc = typeof document !== 'undefined' ? document : undefined) {
  const root = doc?.documentElement;
  if (!root) return;
  root.classList.toggle('dark', resolved === 'dark');
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

/** @type {{ preference: ThemePreference, resolved: ResolvedTheme }} */
let state = { preference: 'system', resolved: 'light' };
const listeners = new Set();
let mediaCleanup = /** @type {(() => void) | null} */ (null);

const emit = () => listeners.forEach(listener => listener());

/** @param {ThemePreference} preference */
const update = (preference) => {
  const resolved = resolveTheme(preference, Boolean(darkQuery()?.matches));
  if (state.preference !== preference || state.resolved !== resolved) {
    state = { preference, resolved };
    emit();
  }
  applyResolvedTheme(resolved);
};

/**
 * Reads the stored preference, applies it and starts following the system
 * setting. Safe to call more than once.
 */
export function initTheme() {
  update(normalizeThemePreference(safeStorageGet('localStorage', THEME_STORAGE_KEY)));
  if (mediaCleanup) return;
  const query = darkQuery();
  if (!query) return;
  const handleChange = () => update(state.preference);
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handleChange);
    mediaCleanup = () => query.removeEventListener('change', handleChange);
  } else if (typeof query.addListener === 'function') {
    query.addListener(handleChange);
    mediaCleanup = () => query.removeListener(handleChange);
  }
}

/** Stops following the system setting (tests). */
export function disposeTheme() {
  mediaCleanup?.();
  mediaCleanup = null;
}

/**
 * Saves and applies a new preference.
 * @param {unknown} preference
 */
export function setThemePreference(preference) {
  const next = normalizeThemePreference(preference);
  safeStorageSet('localStorage', THEME_STORAGE_KEY, next);
  update(next);
}

/** @param {() => void} listener */
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => state;

/**
 * Current theme preference and the theme actually shown.
 * @returns {{ preference: ThemePreference, resolvedTheme: ResolvedTheme, setPreference: (preference: ThemePreference) => void }}
 */
export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { preference: snapshot.preference, resolvedTheme: snapshot.resolved, setPreference: setThemePreference };
}
