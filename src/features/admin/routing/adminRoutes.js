// Pure URL <-> admin route mapping. The admin shell owns every path under
// /admin; App.jsx owns everything else (it pushes '/admin' when an
// administrator session opens), so nothing here ever produces a non-admin path.

export const ADMIN_BASE_PATH = '/admin';

/** Tab identifiers used by the admin shell, mapped to their canonical URLs. */
export const ADMIN_TAB_PATHS = Object.freeze({
  DASHBOARD: '/admin',
  STUDENTS: '/admin/students',
  CLASSES: '/admin/classes',
  SUBJECTS: '/admin/subjects',
  QUESTION_BANK: '/admin/questions',
  AI_IMPORTER: '/admin/import',
  OPERATIONS: '/admin/operations',
  DB_CLEANER: '/admin/database',
  SETTINGS: '/admin/settings'
});

/** @typedef {keyof typeof ADMIN_TAB_PATHS} AdminTab */
/** @typedef {{ tab: AdminTab, examId: string | null }} AdminRoute */

/** @type {Readonly<AdminRoute>} */
export const DEFAULT_ADMIN_ROUTE = Object.freeze({ tab: 'DASHBOARD', examId: null });

const EXAM_DETAIL_PATH = /^\/admin\/exams\/([^/]+)$/;
const EXAM_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** @type {Map<string, AdminTab>} */
const PATH_TO_TAB = new Map(/** @type {Array<[AdminTab, string]>} */ (Object.entries(ADMIN_TAB_PATHS)).map(([tab, path]) => [path, tab]));

/**
 * @param {unknown} pathname
 * @returns {string}
 */
const normalizePathname = (pathname) => {
  const value = typeof pathname === 'string' ? pathname : '';
  return value.length > 1 ? value.replace(/\/+$/, '') || '/' : value;
};

/**
 * True for '/admin' and every path below it.
 * @param {unknown} pathname
 * @returns {boolean}
 */
export function isAdminPath(pathname) {
  const path = normalizePathname(pathname);
  return path === ADMIN_BASE_PATH || path.startsWith(`${ADMIN_BASE_PATH}/`);
}

/**
 * Parses a pathname into an admin route. Returns null for paths outside the
 * admin shell and for unknown admin sub-paths.
 * @param {unknown} pathname
 * @returns {AdminRoute | null}
 */
export function parseAdminPath(pathname) {
  const path = normalizePathname(pathname);
  if (!isAdminPath(path)) return null;
  const tab = PATH_TO_TAB.get(path);
  if (tab) return { tab, examId: null };
  const examMatch = EXAM_DETAIL_PATH.exec(path);
  if (examMatch) {
    let examId;
    try {
      examId = decodeURIComponent(examMatch[1]);
    } catch {
      return null;
    }
    if (EXAM_ID_PATTERN.test(examId)) return { tab: 'DASHBOARD', examId };
  }
  return null;
}

/**
 * Canonical URL for an admin route. An exam detail is always under the Dashboard tab.
 * @param {{ tab?: string | null, examId?: string | null } | null | undefined} route
 * @returns {string}
 */
export function formatAdminPath(route) {
  if (route?.examId) return `${ADMIN_BASE_PATH}/exams/${encodeURIComponent(route.examId)}`;
  return ADMIN_TAB_PATHS[/** @type {AdminTab} */ (route?.tab)] || ADMIN_BASE_PATH;
}

/**
 * Normalises a requested route: unknown tabs fall back to the Dashboard, exam ids only live on it.
 * @param {{ tab?: string | null, examId?: unknown } | null | undefined} route
 * @returns {AdminRoute}
 */
export function normalizeAdminRoute(route) {
  const tab = /** @type {AdminTab} */ (route?.tab && Object.hasOwn(ADMIN_TAB_PATHS, route.tab) ? route.tab : 'DASHBOARD');
  const examId = tab === 'DASHBOARD' && route?.examId ? String(route.examId) : null;
  return { tab, examId };
}

/**
 * Chooses the route to show when the admin shell mounts.
 *
 * App.jsx replaces the loaded URL with '/' and then '/admin' before the
 * shell mounts, so a reload or deep link to e.g. /admin/students would be
 * lost. `initialDocumentPath` (the URL the document was loaded with) restores
 * it once per page load.
 * @param {unknown} currentPathname
 * @param {string | null | undefined} initialDocumentPath
 * @returns {AdminRoute}
 */
export function resolveInitialAdminRoute(currentPathname, initialDocumentPath) {
  const current = parseAdminPath(currentPathname);
  if (current && (current.tab !== 'DASHBOARD' || current.examId)) return current;
  const initial = initialDocumentPath ? parseAdminPath(initialDocumentPath) : null;
  return initial || current || { ...DEFAULT_ADMIN_ROUTE };
}
