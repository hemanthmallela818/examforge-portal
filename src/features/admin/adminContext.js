import { createContext, useContext } from 'react';

/**
 * Cross-cutting administrator services shared by the feature hooks:
 * data-load bookkeeping (runAdminDataLoad, dataLoadState, loadedCollections),
 * table counts, classes, the subject catalog, root authority and the
 * destructive-action dialog. Provided by AdminProvider.
 */

/**
 * @typedef {object} AdminContextValue
 * @property {boolean} isRootDeveloper
 * @property {import('../../types').DataLoadState} dataLoadState
 * @property {import('../../types').RunAdminDataLoad} runAdminDataLoad
 * @property {import('react').RefObject<Set<string>>} loadedCollections
 * @property {import('../../types').TableCounts} tableCounts
 * @property {number | null} dbSize
 * @property {() => Promise<boolean>} fetchTableCounts
 * @property {() => void} scheduleTableCounts
 * @property {ReturnType<typeof import('./classes/useClasses').useClasses>} classBook
 * @property {ReturnType<typeof import('./subjects/useSubjectCatalog').useSubjectCatalog>} catalog
 * @property {import('../../types').DestructiveActionRequest | null} destructiveAction
 * @property {import('react').Dispatch<import('react').SetStateAction<import('../../types').DestructiveActionRequest | null>>} setDestructiveAction
 */

export const AdminContext = createContext(/** @type {AdminContextValue | null} */ (null));

export function useAdminContext() {
  const value = useContext(AdminContext);
  if (!value) throw new Error('useAdminContext must be used inside <AdminProvider>.');
  return value;
}
