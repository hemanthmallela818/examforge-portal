import { useSyncExternalStore } from 'react';

// Matches the index.css breakpoint where the exam stacks into one column.
export const EXAM_NARROW_QUERY = '(max-width: 900px)';

/** @param {string} query */
const getMediaQueryList = (query) => (
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null
);

/**
 * Re-renders the caller only when the media query result flips.
 * @param {string} query
 * @returns {boolean}
 */
export function useMediaQuery(query) {
  return useSyncExternalStore(
    (onChange) => {
      const list = getMediaQueryList(query);
      if (!list) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => Boolean(getMediaQueryList(query)?.matches),
    () => false
  );
}
