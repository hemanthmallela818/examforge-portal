// One read at a time, scheduled from completion so slow school networks cannot
// accumulate requests. Writes use the answer pipeline instead of this owner.
/** @param {(signal: AbortSignal) => Promise<void>} poll */
export function createStudentPoller(poll) {
  let disposed = false;
  let failures = 0;
  let refreshOnReturn = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Promise<void> | null} */
  let running = null;
  const available = () => !disposed && navigator.onLine !== false && document.visibilityState !== 'hidden';
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancelTimer();
    if (!available()) return;
    const delay = Math.min((20_000 + Math.random() * 10_000) * 2 ** failures, 120_000);
    timer = setTimeout(refresh, delay);
  };
  const refresh = () => {
    cancelTimer();
    if (!available()) return Promise.resolve();
    if (running) return running;
    controller = new AbortController();
    const signal = controller.signal;
    running = (async () => {
      try {
        await poll(signal);
        if (!signal.aborted) failures = 0;
      } catch {
        if (!signal.aborted) failures = Math.min(failures + 1, 3);
      } finally {
        running = null;
        controller = null;
        if (refreshOnReturn && available()) {
          refreshOnReturn = false;
          timer = setTimeout(refresh, 0);
        } else {
          schedule();
        }
      }
    })();
    return running;
  };
  const onAvailability = () => {
    if (!available()) {
      cancelTimer();
      controller?.abort();
    } else if (running) {
      refreshOnReturn = true;
    } else {
      void refresh();
    }
  };
  document.addEventListener('visibilitychange', onAvailability);
  window.addEventListener('online', onAvailability);
  window.addEventListener('offline', onAvailability);
  return {
    refresh,
    postpone: () => { failures = 0; if (!running) schedule(); },
    dispose: () => {
      disposed = true;
      cancelTimer();
      controller?.abort();
      document.removeEventListener('visibilitychange', onAvailability);
      window.removeEventListener('online', onAvailability);
      window.removeEventListener('offline', onAvailability);
    }
  };
}
