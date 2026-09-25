import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_ADMIN_ROUTE,
  formatAdminPath,
  isAdminPath,
  normalizeAdminRoute,
  parseAdminPath,
  resolveInitialAdminRoute
} from './adminRoutes';

// The document's own URL is honoured as a deep link only for the first admin
// shell mounted in this page load (a later sign-in starts on the Dashboard).
let initialDocumentPathConsumed = false;

const readInitialDocumentPath = () => {
  if (initialDocumentPathConsumed) return null;
  try {
    const [entry] = window.performance?.getEntriesByType?.('navigation') || [];
    return entry?.name ? new URL(entry.name).pathname : null;
  } catch {
    return null;
  }
};

const readInitialRoute = () => resolveInitialAdminRoute(window.location.pathname, readInitialDocumentPath());

/**
 * @param {string} path
 * @param {boolean} replace
 */
const writeHistory = (path, replace) => {
  try {
    const state = { ...(window.history.state || {}), adminRoute: path };
    if (replace) window.history.replaceState(state, '', path);
    else window.history.pushState(state, '', path);
  } catch (error) {
    console.error('Admin navigation could not update the address bar:', error);
  }
};

/**
 * Admin tab routing on top of the History API (no router dependency).
 * - navigate() pushes /admin/* entries (replace: true rewrites the current one);
 * - Back/Forward (popstate) restore the tab and selected exam;
 * - reloads and deep links restore the tab through resolveInitialAdminRoute.
 */
export function useAdminRoute() {
  const [route, setRoute] = useState(readInitialRoute);
  const initialRouteRef = useRef(route);

  // Layout effect: the address bar is canonical before the first admin screen paints.
  useLayoutEffect(() => {
    initialDocumentPathConsumed = true;
    const path = formatAdminPath(initialRouteRef.current);
    // Canonicalise the address bar without adding a history entry. Paths
    // outside /admin belong to App.jsx and are left alone.
    if (isAdminPath(window.location.pathname) && window.location.pathname !== path) writeHistory(path, true);
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const pathname = window.location.pathname;
      if (!isAdminPath(pathname)) return;
      setRoute(parseAdminPath(pathname) || { ...DEFAULT_ADMIN_ROUTE });
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((/** @type {{ tab?: string | null, examId?: unknown } | null | undefined} */ nextRoute, /** @type {{ replace?: boolean }} */ { replace = false } = {}) => {
    const normalized = normalizeAdminRoute(nextRoute);
    setRoute(normalized);
    const path = formatAdminPath(normalized);
    if (window.location.pathname === path) return;
    writeHistory(path, replace);
  }, []);

  return { activeTab: route.tab, activeExamId: route.examId, navigate };
}
