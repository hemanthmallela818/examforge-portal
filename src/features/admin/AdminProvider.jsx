import { useState } from 'react';
import { AdminContext } from './adminContext';
import { useAdminDataLoader } from './shared/useAdminDataLoader';
import { useTableCounts } from './shared/useTableCounts';
import { useClasses } from './classes/useClasses';
import { useSubjectCatalog } from './subjects/useSubjectCatalog';

/**
 * Owns the services shared across administrator features and exposes them
 * through AdminContext. Mounted only after administrator access is granted.
 * @param {{ isRootDeveloper: boolean, children?: import('react').ReactNode }} props
 */
export default function AdminProvider({ isRootDeveloper, children }) {
  const { dataLoadState, runAdminDataLoad, loadedCollections } = useAdminDataLoader();
  const { tableCounts, dbSize, fetchTableCounts, scheduleTableCounts } = useTableCounts(runAdminDataLoad);
  const classBook = useClasses({ runAdminDataLoad, scheduleTableCounts, loadedCollections });
  const catalog = useSubjectCatalog();
  const [destructiveAction, setDestructiveAction] = useState(/** @type {import('../../types').DestructiveActionRequest | null} */ (null));

  /** @type {import('./adminContext').AdminContextValue} */
  const value = {
    isRootDeveloper,
    dataLoadState,
    runAdminDataLoad,
    loadedCollections,
    tableCounts,
    dbSize,
    fetchTableCounts,
    scheduleTableCounts,
    classBook,
    catalog,
    destructiveAction,
    setDestructiveAction
  };

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}
