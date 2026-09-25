import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../../../supabase';
import { normalizeLiveOverview } from './liveOverviewLogic';

export const LIVE_OVERVIEW_REFRESH_MS = 30_000;
export const RECENT_RESULT_LIMIT = 5;

/**
 * Live exams, students writing now, attempts awaiting finalization and recent
 * results for the Dashboard Overview. Loads while `enabled`, refreshes every
 * 30 seconds while the page is visible and whenever `refreshKey` changes (the
 * realtime-driven table counts).
 * @param {{ enabled: boolean, refreshKey?: unknown }} options
 */
export function useLiveOverview({ enabled, refreshKey }) {
  const [overview, setOverview] = useState(/** @type {import('./liveOverviewLogic').LiveOverview | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const fetchLiveOverview = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_admin_live_overview', { recent_limit_param: RECENT_RESULT_LIMIT });
      if (rpcError) throw rpcError;
      const next = normalizeLiveOverview(data);
      if (request !== requestRef.current) return false;
      setOverview(next);
      setError('');
      return true;
    } catch (caught) {
      console.error('Live overview could not be loaded:', caught);
      if (request === requestRef.current) setError('Live exam activity could not be loaded. The figures shown may be out of date.');
      return false;
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    fetchLiveOverview();
    return undefined;
  }, [enabled, fetchLiveOverview, refreshKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') fetchLiveOverview();
    }, LIVE_OVERVIEW_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, fetchLiveOverview]);

  useEffect(() => () => { requestRef.current += 1; }, []);

  return { overview, loading, error, fetchLiveOverview };
}
