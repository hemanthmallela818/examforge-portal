import { useCallback, useEffect, useRef, useState } from 'react';
import { createLatestRequestTracker, runWithDeadline } from '../../../adminDataReliability';

/**
 * Shared bookkeeping for every administrator collection load: a per-key
 * loading/error state, latest-request-wins stale-response guards and the set
 * of collections that have been loaded at least once.
 */
export function useAdminDataLoader() {
  const [dataLoadState, setDataLoadState] = useState(/** @type {import('../../../types').DataLoadState} */ ({}));
  const dataLoadTracker = useRef(createLatestRequestTracker());
  const loadedCollections = useRef(/** @type {Set<string>} */ (new Set()));

  useEffect(() => {
    const tracker = dataLoadTracker.current;
    tracker.activate();
    return () => { tracker.deactivate(); };
  }, []);

  /** @type {import('../../../types').RunAdminDataLoad} */
  const runAdminDataLoad = useCallback(async (key, failureMessage, work) => {
    const generation = dataLoadTracker.current.begin(key);
    setDataLoadState(current => ({
      ...current,
      [key]: { loading: true, error: '' }
    }));
    try {
      const data = await runWithDeadline(work);
      const currentRequest = dataLoadTracker.current.isCurrent(key, generation);
      if (currentRequest) {
        setDataLoadState(current => ({
          ...current,
          [key]: { loading: false, error: '' }
        }));
      }
      return { ok: /** @type {const} */ (true), current: currentRequest, data };
    } catch (error) {
      console.error(`${key} loading failed:`, error);
      const currentRequest = dataLoadTracker.current.isCurrent(key, generation);
      if (currentRequest) {
        setDataLoadState(current => ({
          ...current,
          [key]: { loading: false, error: failureMessage }
        }));
      }
      return { ok: /** @type {const} */ (false), current: currentRequest, error };
    }
  }, []);

  return { dataLoadState, runAdminDataLoad, loadedCollections };
}
