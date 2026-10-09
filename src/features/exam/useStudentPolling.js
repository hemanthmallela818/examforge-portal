import { useCallback, useEffect, useRef } from 'react';
import { createStudentPoller } from '../../studentPolling';

/** @param {{ enabled: boolean, key: string, poll: (signal: AbortSignal) => Promise<void> }} options */
export function useStudentPolling({ enabled, key, poll }) {
  const pollRef = useRef(poll);
  useEffect(() => { pollRef.current = poll; });
  const ownerRef = useRef(/** @type {ReturnType<typeof createStudentPoller> | null} */ (null));
  useEffect(() => {
    if (!enabled) return;
    const owner = createStudentPoller(signal => pollRef.current(signal));
    ownerRef.current = owner;
    void owner.refresh();
    return () => { owner.dispose(); ownerRef.current = null; };
  }, [enabled, key]);
  const refresh = useCallback(() => ownerRef.current?.refresh() || Promise.resolve(), []);
  const postpone = useCallback(() => ownerRef.current?.postpone(), []);
  return { refresh, postpone };
}
